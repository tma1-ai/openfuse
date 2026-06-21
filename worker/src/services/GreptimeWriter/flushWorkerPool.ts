import { Worker } from "worker_threads";
import path from "path";

import {
  GreptimeWorkerWriteError,
  logger,
  type WriteErrorClassification,
} from "@langfuse/shared/src/server";

import { env } from "../../env";
import type { FlushEntries, FlushResult } from "./flushWorkerCore";

/**
 * worker_threads pool that runs GreptimeDB flushes (`rows -> Table -> client.write`) off the worker's
 * main event loop. The synchronous protobuf encode inside `client.write` was blocking the loop for
 * ~70-100ms per fan-out and starving the per-job raw_events reads; moving it to a pool keeps the loop
 * free to interleave reads, which is what lifts drain throughput.
 *
 * Correctness boundary: the pool is a dumb executor. It does not retry, reorder, requeue, or bisect —
 * `GreptimeWriter` owns all of that on the main thread and re-dispatches sub-batches here. The pool
 * only (a) carries plain clone-safe rows in, (b) carries the write outcome out, and (c) reconstructs a
 * `GreptimeWorkerWriteError` on THIS (main) thread from the worker's already-computed classification,
 * so the classifier's `instanceof` checks — which can't survive the postMessage hop — still hold.
 *
 * No request timeout — deliberately. The main thread releases a flush's `inFlightEntities` only once
 * its write SETTLES, which serializes one entity's writes so the latest generation lands last. A
 * wrapper timeout would reject the main-thread promise while the worker's gRPC `client.write` is still
 * in flight (postMessage cannot cancel it); the entity would be released and requeued, a newer
 * generation could land, and the orphaned old write could then commit on top of it — corrupting the
 * `eav_generation` correlation. So a request settles only on a real worker reply or that worker's
 * death; we never invent a settle the worker hasn't confirmed. This matches the original in-process
 * writer, which `await`ed `client.write` with no timeout. A worker death fails ONLY its own requests
 * (a dropped gRPC connection did not commit), leaving healthy workers' in-flight writes to settle.
 */

interface PendingRequest {
  resolve: (affectedRows: number) => void;
  reject: (error: Error) => void;
  /**
   * The worker this request was dispatched to. On a worker death only ITS requests are failed; a
   * healthy worker's in-flight write is left pending so it settles truthfully (see write()).
   */
  worker: Worker;
}

interface FlushWorkerPoolState {
  workers: Worker[];
  currentWorkerIndex: number;
  pendingRequests: Map<string, PendingRequest>;
}

class FlushWorkerPool {
  private pool: FlushWorkerPoolState;
  private readonly workerPath: string;
  private readonly poolSize: number;
  private requestCounter = 0;
  /** Set once `terminate()` starts so the exit/error handlers don't treat a deliberate stop as a crash. */
  private terminating = false;

  constructor(poolSize: number) {
    this.poolSize = poolSize;
    // Compiled JS entry; in dev (tsx) __dirname is src/..., in prod it is dist/..., and the entry's
    // own require of the core uses ../../../dist so both resolve to worker/dist. See flush-worker.js.
    this.workerPath = path.join(__dirname, "flush-worker.js");
    this.pool = {
      workers: [],
      currentWorkerIndex: 0,
      pendingRequests: new Map(),
    };
    for (let i = 0; i < this.poolSize; i++) {
      this.pool.workers.push(this.createWorkerWithListeners());
    }
  }

  private createWorkerWithListeners(): Worker {
    const worker = new Worker(this.workerPath);

    worker.on("message", (data: { id: string; result: FlushResult }) => {
      const request = this.pool.pendingRequests.get(data.id);
      if (!request) return;
      this.pool.pendingRequests.delete(data.id);

      if (data.result.ok) {
        request.resolve(data.result.affectedRows);
      } else {
        request.reject(
          this.toWriteError(data.result.classification, data.result.message),
        );
      }
    });

    // A crashed worker: fail ONLY this worker's in-flight requests as transient (the classifier treats
    // a non-SDK error as transient), so the main thread requeues them, then replace the worker. Healthy
    // workers' requests are left pending to settle truthfully. `terminate()` also raises exit/error, so
    // skip replacement once a deliberate teardown is underway.
    worker.on("error", (error) => {
      if (this.terminating) return;
      logger.error("GreptimeDB flush worker error", error);
      this.replaceWorker(worker);
    });
    worker.on("exit", (code) => {
      if (this.terminating || code === 0) return;
      logger.error(`GreptimeDB flush worker exited with code ${code}`);
      this.replaceWorker(worker);
    });

    return worker;
  }

  /** Rebuild a write error on the main thread so `classifyGreptimeWriteError`'s instanceof passes. */
  private toWriteError(
    classification: WriteErrorClassification,
    message: string,
  ): GreptimeWorkerWriteError {
    return new GreptimeWorkerWriteError(classification, message);
  }

  /** Fail (reject) the pending requests matching `predicate`. Plain Error -> classified transient. */
  private failPending(
    reason: string,
    predicate: (request: PendingRequest) => boolean,
  ): void {
    for (const [id, request] of this.pool.pendingRequests.entries()) {
      if (!predicate(request)) continue;
      this.pool.pendingRequests.delete(id);
      // Plain Error -> classified transient -> requeued by the caller; a dropped connection did not
      // commit, so re-driving the same generation through the queue is safe and idempotent.
      request.reject(new Error(reason));
    }
  }

  private replaceWorker(deadWorker: Worker): void {
    const index = this.pool.workers.indexOf(deadWorker);
    if (index === -1) return;
    // Fail ONLY the dead worker's requests: its gRPC connection dropped, so those writes did not
    // commit. Healthy workers' requests stay pending until they settle truthfully — failing them would
    // orphan an in-flight write that may still land out of generation order. Then refill the slot.
    this.failPending(
      "GreptimeDB flush worker failed and is being replaced",
      (request) => request.worker === deadWorker,
    );
    this.pool.workers[index] = this.createWorkerWithListeners();
  }

  private getNextWorker(): Worker {
    const worker = this.pool.workers[this.pool.currentWorkerIndex];
    this.pool.currentWorkerIndex =
      (this.pool.currentWorkerIndex + 1) % this.poolSize;
    return worker;
  }

  /**
   * Offload one combined flush to a worker. Resolves with the affected row count, or rejects with a
   * `GreptimeWorkerWriteError` carrying the worker's classification (or a plain transient Error if that
   * worker dies). Settles only on a real reply or that worker's death — never on a timeout the worker
   * hasn't confirmed (see the class doc). Rows must be clone-safe — they are (plain JSON values;
   * Decimal is coerced to number upstream in the row builders).
   */
  async write(entries: FlushEntries): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const id = `flush-${++this.requestCounter}-${Date.now()}`;
      const worker = this.getNextWorker();
      this.pool.pendingRequests.set(id, { resolve, reject, worker });
      worker.postMessage({ id, entries });
    });
  }

  async terminate(): Promise<void> {
    this.terminating = true;
    // Deliberate shutdown runs after the writer's final `flushAll(true)` drain, so nothing live should
    // be in flight; fail any straggler so its promise doesn't dangle as the process exits.
    this.failPending("GreptimeDB flush worker pool is terminating", () => true);
    await Promise.all(this.pool.workers.map((worker) => worker.terminate()));
    this.pool.workers = [];
  }
}

let pool: FlushWorkerPool | null = null;

/** Lazily build the singleton flush worker pool (sized by `LANGFUSE_GREPTIME_FLUSH_WORKER_POOL_SIZE`). */
export function getFlushWorkerPool(): FlushWorkerPool {
  if (!pool) {
    pool = new FlushWorkerPool(env.LANGFUSE_GREPTIME_FLUSH_WORKER_POOL_SIZE);
  }
  return pool;
}

/** Terminate the pool on worker shutdown, if it was ever started. */
export async function terminateFlushWorkerPool(): Promise<void> {
  if (pool) {
    await pool.terminate();
    pool = null;
  }
}
