// Process supervisor for the single-container Openfuse standalone image.
//
// The standalone image bundles both long-running Openfuse processes — the Next.js web server and the
// worker — and runs them side by side in one container (the GreptimeDB-standalone analogue: one
// image, full stack, single-node self-host). dumb-init stays PID 1 (signal forwarding + zombie
// reaping); this supervisor owns the two children.
//
// Semantics:
//   - Spawn web and worker with inherited stdio so their logs flow to the container's stdout.
//   - On SIGTERM/SIGINT (expected shutdown): forward the signal to both children, wait for them to
//     exit gracefully (then SIGKILL after a grace period), and exit 0.
//   - On an unexpected child exit: this is a single unit of failure — kill the surviving child and
//     exit non-zero so the container's restart policy restarts the whole thing (mirrors how a crash
//     in either split-image container would restart that container).
//
// Kept dependency-free (Node built-ins only) so it needs nothing installed in the runtime image.

import { spawn } from "node:child_process";

// Grace window before SIGKILLing a child that has not exited. The worker's own graceful drain can
// run long (it finishes in-flight queue jobs); BullMQ re-queues anything still stalled on the next
// start, so a moderate default trades a little drain time for a bounded stop. Raise both this and the
// container's stop_grace_period to give the worker a full drain. Docker SIGKILLs PID 1 at
// stop_grace_period regardless, so this must stay below it to take effect.
const GRACE_MS = Number(process.env.OPENFUSE_SHUTDOWN_GRACE_MS || 25_000);

const WEB_DIR = process.env.OPENFUSE_WEB_DIR || "/app/web-standalone";
const WORKER_DIR = process.env.OPENFUSE_WORKER_DIR || "/app/worker";
const WEB_PORT = process.env.OPENFUSE_WEB_PORT || process.env.PORT || "3000";
const WORKER_PORT = process.env.OPENFUSE_WORKER_PORT || "3030";

const procs = [
  {
    name: "web",
    cmd: "node",
    // Mirror web/Dockerfile's CMD keep-alive tuning for the Next.js standalone server.
    args: ["web/server.js", "--keepAliveTimeout", "110000"],
    cwd: WEB_DIR,
    port: WEB_PORT,
    // Next standalone binds HOSTNAME; force 0.0.0.0 so the container is reachable.
    env: { ...process.env, PORT: WEB_PORT, HOSTNAME: "0.0.0.0" },
  },
  {
    name: "worker",
    cmd: "node",
    args: ["dist/index.js"],
    cwd: WORKER_DIR,
    port: WORKER_PORT,
    env: { ...process.env, PORT: WORKER_PORT },
  },
];

let shuttingDown = false;
let exitCode = 0;
let killTimer = null;

const log = (msg) => console.log(`[supervisor] ${msg}`);

const children = procs.map((p) => {
  log(`starting ${p.name}: ${p.cmd} ${p.args.join(" ")} (cwd=${p.cwd}, PORT=${p.port})`);
  const child = spawn(p.cmd, p.args, { cwd: p.cwd, env: p.env, stdio: "inherit" });
  const entry = { ...p, child, exited: false };

  child.on("exit", (code, signal) => {
    entry.exited = true;
    const resolved = code == null ? (signal ? 1 : 0) : code;
    if (!shuttingDown) {
      // First unexpected exit drives the whole container down.
      exitCode = resolved === 0 ? 1 : resolved;
      log(
        `${p.name} exited unexpectedly (code=${code}, signal=${signal}); stopping the container (exit ${exitCode}).`,
      );
      beginShutdown("SIGTERM");
    } else {
      log(`${p.name} exited (code=${code}, signal=${signal}).`);
    }
    finalizeIfAllExited();
  });

  child.on("error", (err) => {
    entry.exited = true;
    log(`${p.name} failed to start: ${err?.message ?? err}`);
    if (!shuttingDown) {
      exitCode = 1;
      beginShutdown("SIGTERM");
    }
    finalizeIfAllExited();
  });

  return entry;
});

function beginShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const entry of children) {
    if (!entry.exited) {
      try {
        entry.child.kill(signal);
      } catch {
        // child already gone
      }
    }
  }
  killTimer = setTimeout(() => {
    for (const entry of children) {
      if (!entry.exited) {
        log(`${entry.name} did not exit within ${GRACE_MS}ms; sending SIGKILL.`);
        try {
          entry.child.kill("SIGKILL");
        } catch {
          // child already gone
        }
      }
    }
  }, GRACE_MS);
  killTimer.unref();
}

function finalizeIfAllExited() {
  if (children.every((entry) => entry.exited)) {
    if (killTimer) clearTimeout(killTimer);
    log(`all processes exited; exiting ${exitCode}.`);
    process.exit(exitCode);
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log(`received ${signal}; forwarding to children for graceful shutdown.`);
    // Operator-initiated shutdown is expected: exit 0 once children stop.
    beginShutdown(signal);
  });
}
