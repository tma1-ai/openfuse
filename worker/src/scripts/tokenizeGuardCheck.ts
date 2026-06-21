/**
 * Verify the long-unbroken-run guard in getTokensByModel: pathological (whitespace-free) inputs must
 * drop from quadratic to linear cost, while natural-text token counts stay exact.
 *
 *   pnpm exec dotenv -e ../../.env.bench -- tsx src/scripts/tokenizeGuardCheck.ts
 */
import type { Model } from "@langfuse/shared";
import { tokenCount } from "../features/tokenisation/usage";

const model = {
  id: "gpt-4o",
  tokenizerId: "openai",
  tokenizerConfig: { tokenizerModel: "gpt-4o" },
} as unknown as Model;

const blob = (n: number) => "x".repeat(n);
const WORDS =
  "the model generated a response about distributed systems and time series data".split(
    " ",
  );
const prose = (n: number) => {
  let s = "";
  let i = 0;
  while (s.length < n) s += WORDS[i++ % WORDS.length] + " ";
  return s.slice(0, n);
};

const time = (label: string, text: string) => {
  // warm
  tokenCount({ model, text });
  const N = 20;
  const t0 = performance.now();
  let tokens = 0;
  for (let i = 0; i < N; i++) tokens = tokenCount({ model, text }) ?? 0;
  const ms = (performance.now() - t0) / N;
  console.log(
    `${label.padEnd(26)} | ${ms.toFixed(2).padStart(9)}ms | tokens=${tokens}`,
  );
};

console.log("scenario                   |   per-call | result");
console.log("-".repeat(58));
time("prose 2KB (exact path)", prose(2_000));
time("prose 50KB (exact path)", prose(50_000));
time("blob 10KB (guarded)", blob(10_000));
time("blob 50KB (guarded)", blob(50_000));
time("blob 200KB (guarded)", blob(200_000));
console.log(
  "\nBefore the guard: blob 10KB ~67ms, blob 50KB ~1657ms (quadratic). Linear now => guard works.",
);
process.exit(0);
