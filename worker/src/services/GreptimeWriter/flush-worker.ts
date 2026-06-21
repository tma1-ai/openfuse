// Ensure to keep this file 100% compatible with flush-worker.js

const { parentPort } = require("worker_threads");
// Compiled core: the relative `../../../dist/...` path resolves to `worker/dist/...` from both the
// dev entry (src/services/GreptimeWriter, run by tsx) and the prod entry (dist/services/GreptimeWriter,
// run by node) — both sit three levels under `worker/`. Mirrors the tokenisation worker.
const {
  runFlush,
} = require("../../../dist/services/GreptimeWriter/flushWorkerCore.js");

// Worker thread entry point: rows in, write outcome out. All retry/ordering stays on the main thread.
if (parentPort) {
  parentPort.on("message", (data: { id: string; entries: unknown }) => {
    runFlush(data.entries)
      .then((result: unknown) =>
        parentPort.postMessage({ id: data.id, result }),
      )
      .catch((error: unknown) => {
        // runFlush catches its own write/encode errors; this only fires on an unexpected throw. Report
        // a transient classification so the main thread retries rather than dropping data.
        parentPort.postMessage({
          id: data.id,
          result: {
            ok: false,
            classification: {
              class: "transient",
              errorClass: "worker_unexpected",
            },
            message: error instanceof Error ? error.message : "Unknown error",
          },
        });
      });
  });
}
