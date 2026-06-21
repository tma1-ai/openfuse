# Benchmark Report: Openfuse (GreptimeDB) vs Upstream Langfuse (ClickHouse)

End-to-end benchmark of the live ingestion drain, query latency, and storage footprint, comparing
Openfuse on GreptimeDB against upstream Langfuse on ClickHouse on identical hardware and load.

Measured for `1.0.0-alpha.2`. The throughput work landed in PR #54 (merge `ebc6e60be`):

- `6430eea33` — perf(greptime): cut ingestion drain bottlenecks + fix cold-start empty cost
- `78538faae` — fix(greptime): make EAV generation unique within a millisecond
- `f3790f7a1` — chore(greptime): address PR review comments

## Setup

- **Load**: 60,000 traces, each = 1 trace + 1 span + 1 generation (with token usage) → 120,000
  observations + 80,004 scores. 6 producer processes via the Langfuse SDK against the public
  ingestion API.
- **Topology**: split `web` + `worker` (single worker), default ingestion concurrency. The two stacks
  run **isolated** (only one up at a time), each on **fresh volumes**.
- **Fork**: GreptimeDB v1.1.1. **Upstream**: official Langfuse v3.184.1 / ClickHouse 24.8.
- Storage measured after the full load drains and each engine settles (GreptimeDB compaction;
  ClickHouse `OPTIMIZE FINAL` + background merges).

## 1. Ingestion drain throughput

The headline metric: how fast the worker drains the queued ingestion backlog into the analytics store.

|                   | Fork (before this work) | **Fork (alpha.2)** | Upstream       |
| ----------------- | ----------------------- | ------------------ | -------------- |
| Drain throughput  | ~24–27 traces/s         | **108.1 traces/s** | 149.3 traces/s |
| Completed all 60k | No — stalled at 49,710  | **Yes**            | Yes            |
| Producer time     | —                       | 120 s              | 140 s          |
| End-to-end drain  | did not finish          | 555 s              | 402 s          |

The fork went from **stalling before completion** to fully draining 60k at ~4× the old rate. The
remaining gap to ClickHouse is **~1.38×**.

### What lifted it

The fork's worker had been collapsing under three independent bottlenecks, each isolated and fixed:

- **Off-loaded protobuf encode.** The synchronous `encodeTables` inside the GreptimeDB ingester's
  `client.write` (~70–100 ms per fan-out) ran on the worker's event loop and starved every job's
  `raw_events` read. It now runs in a `worker_threads` pool; ordering, retry, and batch-failure
  isolation stay on the main thread.
- **Table-scoped `raw_events` flush.** The per-event full-primary-key point read was an O(memtable)
  scan while data sat unflushed (~117 ms in an `EXPLAIN ANALYZE`). A timed `ADMIN
flush_table('raw_events')` keeps that table's history in prunable SSTs, dropping the read ~20× (to
  ~6 ms), without flushing every table (`auto_flush_interval` is engine-global).
- **Rebuild coalescing.** A per-entity Redis watermark lets a queued job skip its read + rebuild when
  a prior idempotent rebuild already covered all of its events — the dominant redundancy when draining
  a backlog.

## 2. Query latency

The dashboard query path is the fork's current weak spot. Median over 4 representative
`/api/public/metrics` queries, 6 runs each (all HTTP 200, results correct):

| Query                                          | Fork   | Upstream | Fork slower by |
| ---------------------------------------------- | ------ | -------- | -------------- |
| Traces count                                   | 121 ms | 35 ms    | ~3.5×          |
| Observations `totalCost` sum, grouped by model | 268 ms | 31 ms    | ~8.6×          |
| Observations latency p95, grouped by name      | 264 ms | 34 ms    | ~7.8×          |
| Scores avg, grouped by name                    | 67 ms  | 36 ms    | ~1.9×          |

Fork queries are **2–8× slower** than ClickHouse, the worst on observation aggregations that go
through the EAV joins and the UDDSKETCH approximate quantile. This is on a small (60k) dataset and is
the priority for the next optimization round (read path, not drain).

## 3. Storage footprint

All-data, both engines fully settled:

|                     | Fork (GreptimeDB)                                    | Upstream (ClickHouse)         |
| ------------------- | ---------------------------------------------------- | ----------------------------- |
| Analytics DB volume | **215 MiB** (holds `raw_events` + projections + EAV) | 755 MiB (projections only)    |
| Event blob store    | **0 MiB** (no separate blob store)                   | 1,017 MiB (MinIO event blobs) |
| **Total data**      | **~215 MiB**                                         | **~1,772 MiB**                |

The fork stores the full event source-of-truth plus projections plus EAV side-tables in **one
GreptimeDB volume** at ~**8× less** total disk, with **no separate object/blob store** — upstream needs
~1 GiB of MinIO for event blobs in addition to ClickHouse. (An earlier measurement reported ~10×, but
that compared against ClickHouse's pre-merge size; after merges the ratio is ~8×.)

Peak analytics-DB container memory during the run: fork 3,777 MB vs upstream 1,535 MB.

## 4. Correctness / query parity

| Query                    | Fork       | Upstream   |                               |
| ------------------------ | ---------- | ---------- | ----------------------------- |
| Traces count             | 60,000     | 60,000     | exact                         |
| Distinct observations    | 120,000    | 120,000    | exact, no data loss           |
| `totalTokens` sum        | 70,462,547 | 70,462,547 | exact                         |
| `totalCost` sum (gpt-4o) | 322.035    | 322.035    | exact                         |
| Latency p95 by name      | ~4965 ms   | ~4762 ms   | ~4% (UDDSKETCH approximation) |

Row counts and the cost/token aggregates match upstream exactly. The p95 difference is GreptimeDB's
UDDSKETCH relative-error bucketing on uniform synthetic latencies — grouping and labels are correct;
it is an approximation, not a regression.

## 5. Summary

| Dimension        | Fork           | Upstream           | Winner            |
| ---------------- | -------------- | ------------------ | ----------------- |
| Drain throughput | 108 traces/s   | 149 traces/s       | Upstream, ~1.38×  |
| Query latency    | 120–270 ms     | 30–35 ms           | Upstream, ~2–8×   |
| Total storage    | ~215 MiB       | ~1,772 MiB         | **Fork, ~8×**     |
| Stack            | one GreptimeDB | ClickHouse + MinIO | **Fork, simpler** |
| Data correctness | exact          | —                  | tie               |

The fork's clear wins are **storage (~8×)** and **stack simplicity** (one engine, no blob store). Write
throughput is now within ~1.38× of ClickHouse and no longer stalls. **Query latency (2–8× slower) is
the main remaining gap** and the focus of the next phase.

## Caveats

- Single worker. Production drain is a queue consumer that scales horizontally; some of the throughput
  gap may be a single-process artifact and should be re-measured with multiple worker replicas.
- Synthetic, uniform load. Latencies and payload shapes are not production-representative; the p95
  approximation and the read-path costs may differ on real traffic.
- The throughput numbers are post-fix; the "before" figure is from the same harness prior to PR #54.
