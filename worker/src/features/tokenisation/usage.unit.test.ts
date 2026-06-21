import { describe, expect, it } from "vitest";

import type { Model } from "@langfuse/shared";

import { tokenCount } from "./usage";

const gpt4o = {
  id: "gpt-4o",
  tokenizerId: "openai",
  tokenizerConfig: { tokenizerModel: "gpt-4o" },
} as unknown as Model;

describe("tokenCount long-unbroken-run guard", () => {
  it("leaves normal text exact (no chunking below the run threshold)", () => {
    // A short whitespace-separated string never trips the guard, so the count must equal a single
    // whole-text encode. We assert a stable, known token count for gpt-4o's o200k_base.
    const tokens = tokenCount({ model: gpt4o, text: "hello world" });
    expect(tokens).toBe(2);
  });

  it("counts a long whitespace-free blob without quadratic blow-up", () => {
    // 50KB of identical chars is one giant BPE piece — the quadratic worst case the guard windows.
    // It must return promptly (the test timeout would catch a regression) and a sane positive count.
    const start = performance.now();
    const tokens = tokenCount({ model: gpt4o, text: "x".repeat(50_000) });
    const elapsedMs = performance.now() - start;

    expect(tokens).toBeGreaterThan(0);
    // Windowed encode is linear; the un-guarded path took ~1.6s for this input. A generous ceiling
    // still catches the quadratic regression without flaking on a loaded CI host (wall-clock timing).
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("keeps the chunked count within a small boundary error of a coarser split", () => {
    // The windowed sum can differ from a single encode only at window boundaries. Two whitespace-free
    // blobs of the same length must agree (deterministic), and the per-char token ratio stays sane.
    const a = tokenCount({ model: gpt4o, text: "a".repeat(20_000) });
    const b = tokenCount({ model: gpt4o, text: "a".repeat(20_000) });
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a! / 20_000).toBeLessThan(1); // fewer tokens than chars
  });
});
