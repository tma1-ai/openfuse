# Upstream Porting Ledger (v3.184.1 → v3.194.0)

Openfuse is a hard fork of Langfuse based on upstream **`v3.184.1`**. Upstream has
since moved to **`v3.194.0`** (167 non-merge commits). This ledger tracks which
of those upstream changes should be ported into the fork, which are dropped by
design, and which need a Greptime-specific rewrite — so gaps surface on purpose
instead of by accident.

## Scope of this pass

- **Triaged:** the **55 `fix` + `perf` commits** in `v3.184.1..v3.194.0` — the
  correctness/robustness class most likely to matter for a fork.
- **Not yet triaged:** `feat` (55), `chore` (47), `docs` (6), `ci` (3),
  `refactor` (1) — 112 commits. `feat` may still hide security- or
  correctness-relevant changes; a follow-up scan is warranted.

## Method & confidence

Each commit is classified from its conventional-commit **scope + subject**,
cross-checked against **verified fork facts**:

- in-app AI **agent** feature: **absent** in the fork (no `web/src/features/agent*`).
- Present in the fork: `web-callouts`, `blobstorage`, `mixpanel`, `slack`,
  `monitors`, `mcp`, `experiments`, `annotation-queues`, `sessions`.
- Observation/score/session reads go through `packages/shared/src/server/repositories/greptime/*`,
  not the ClickHouse repositories.

Items I classified **without reading the diff** are tagged `[review]` — read the
diff before porting. High-confidence buckets (`done`, agent `drop`, CI
`not-applicable`) are unmarked.

## Legend

| Tag                | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `done`             | Already ported (branch `upstream-backports`).                                               |
| `must-port`        | Generic correctness/robustness; feature exists in the fork.                                 |
| `greptime-rewrite` | ClickHouse/query-shape specific; needs adaptation to Greptime, not a straight cherry-pick.  |
| `by-design-drop`   | Targets a feature the fork removed (in-app agent, v4 events UI, cloud/support entitlement). |
| `not-applicable`   | CI/seeder/deploy-env tooling with no fork runtime impact.                                   |

---

## Done (this branch)

| Commit      | Subject                                                                   | Note                             |
| ----------- | ------------------------------------------------------------------------- | -------------------------------- |
| `dea1cf8a1` | fix(llm): route Vertex Claude through Anthropic client (#14388)           | Ported as A.                     |
| `98eb8d3e4` | fix(tracing): send batchIO I/O queries as POST to avoid HTTP 431 (#14393) | Ported as B (3 fork call sites). |
| `c5f1090ee` | fix: oversized response bodies → 4xx (#14398)                             | Ported as C.                     |

## must-port — high priority (silent failures / security / availability)

| Commit      | Subject                                                                                         | Note                                                  |
| ----------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `c753ff5db` | fix: S3/MinIO event storage fails silently when observation IDs exceed ext4 NAME_MAX (#14090)   | Silent data loss on self-hosted object storage.       |
| `4b99ac377` | fix(blob-storage): trim credentials before encryption to prevent SignatureDoesNotMatch (#14314) | Broken blob export auth.                              |
| `37e0bb928` | fix(chatml): guard against null scope in provider adapter detection (#14308)                    | LLM null-guard.                                       |
| `f23edbcf0` | fix(mcp): add allowed hosts to be set (#14270)                                                  | MCP host allowlist (SSRF-adjacent).                   |
| `eab19e4dc` | fix(callouts): ratelimits should fail open (#14329)                                             | Availability: rate-limit path should not fail closed. |
| `543465bcd` | fix(worker): throttle Mixpanel integration exports (#13958)                                     | Export throttling robustness.                         |
| `00a54b1f2` | fix(slack): prepend basePath to OAuth callback redirects (#14397)                               | basePath correctness for self-hosted.                 |

## must-port — build / validation

| Commit                    | Subject                                                                            | Note                                                         |
| ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `c8ca4c737`               | fix(deps): pin @types/nodemailer to v7 to unbreak next-auth typecheck (#14380)     | Build health.                                                |
| `a0f498aec`               | fix(worker): resolve app default export under tsx ESM interop (#14219)             | Worker runtime `[review]`.                                   |
| `f9c8c040c`               | fix(datasets): enforce id max length 255 (#14205)                                  | Input validation.                                            |
| `408efb84c`               | fix: refine API error logging and prompt validation handling (#14215)              | `[review]`                                                   |
| `43a10b5cd`               | fix(api): guide rate-limited users to v2 observations (#14360)                     | `[review]`                                                   |
| `19f5d6ead`               | fix(web): trace only 5xx tRPC errors (#14385)                                      | Sentry noise; fork's `[trpc].ts` onError differs `[review]`. |
| `850e8fe83` / `11812703a` | fix(blob-storage): surface SDK error cause in validation failures (#14281, #14276) | Diagnostics.                                                 |

## must-port — UI (lower priority)

| Commit      | Subject                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `fceafb74c` | fix(annotation-queues): make queue dropdown scrollable (#14378)        |
| `3c46ac4b3` | fix(search-bar): sync filters sidebar ↔ search bar (#14355)            |
| `84a0a32f8` | fix(search-bar): land on trailing space when committing (#14346)       |
| `dee4118e8` | fix(search-bar): caret in safari, move time selector (#14339)          |
| `bf90651a9` | fix(scores): render categorical value dropdown in filter (#14292)      |
| `49ae44ebc` | fix(ui): resolve app theme in CodeBlock for dark mode (#14200)         |
| `058024ff9` | fix(monitors): threshold input editing glitch (#14260)                 |
| `f2f0b2ebc` | fix(monitors): populate Level/Type filter options from API (#14268)    |
| `cf53f2e68` | fix(experiments): add dataset selector to run form (#14204)            |
| `3d5ec0e90` | fix(ui): show 'Pending' not 'Inactive' for idle blob exporter (#14277) |
| `26a28f4bd` | fix(callouts): styling and doc links (#14275)                          |
| `b8db8b625` | fix(annotation): trace-level scores when in FP (#13587) `[review]`     |

## must-port — LLM (sibling of A)

| Commit      | Subject                                                                        | Note                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f317335e6` | fix(anthropic): remove default disabled thinking for fable and mythos (#14221) | The adaptive-thinking PR A deliberately excluded. Needs the `isAnthropicAlwaysAdaptiveThinkingModel` base infra first; only relevant if the fork serves Fable/Mythos. `[review]` |

## greptime-rewrite (ClickHouse / query-shape specific)

The fix targets a ClickHouse query or index the fork replaced with a Greptime
repository. The _concern_ may still apply, but the patch does not port straight.

| Commit      | Subject                                                                             | Note                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `f8f1c6db0` | perf(observations-v2): LEFT ANY JOIN, remove shadow query (#14395)                  | CH observations-v2.                                                                                                                        |
| `a3b6bf60d` | perf: restrict scores subquery to trace IDs in dataset-runs CTEs (#14259)           | CH CTE.                                                                                                                                    |
| `de483b32b` | perf(api): redundant timestamp bound on scores v3 cursor for index pruning (#14230) | CH index pruning; the _timestamp-bound_ idea is directly relevant to the fork's Greptime TIME INDEX pruning (cf. sessions time-bound bug). |
| `612725c49` | fix(api): don't let scores value operator override timestamp filters (#14217)       | Filter-builder correctness `[review]`.                                                                                                     |
| `f887b3dae` | fix: gate sessions events session_id pushdown on 'any of' operator (#14202)         | Sessions pushdown `[review]`.                                                                                                              |
| `580888180` | fix(sessions): time sorting by createdAt (#14370)                                   | Sessions ordering `[review]`.                                                                                                              |
| `c8860d155` | fix(media): drop media link foreign keys (#14170)                                   | Postgres migration; check fork media schema `[review]`.                                                                                    |

## by-design-drop (feature absent in fork)

| Commit      | Subject                                                                                      | Reason                          |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------- |
| `d7f46b998` | fix(agent): minor styling fixes (#14368)                                                     | in-app agent absent             |
| `6257c8db2` | fix(agent): exclude `langfuse-*` envs (#14366)                                               | in-app agent absent             |
| `3a6aad2d7` | fix(agent): avoid unrecognized stream chunk warnings (#14296)                                | in-app agent absent             |
| `08bc9632c` | fix(agent): small improvements (#14248)                                                      | in-app agent absent             |
| `870b84932` | fix(batch-export): read observations from events table for v4 users (#14216)                 | v4 events UI                    |
| `97c153326` | fix(batch-export): read scores trace metadata from events table for v4 users (#14203)        | v4 events UI                    |
| `59110f367` | fix(batch-actions): snapshot v4 events-table flag (#14201)                                   | v4 events UI                    |
| `03c38ec6d` | fix(blob-storage): don't overwrite enriched export source after V4-preview rollback (#14225) | v4 preview path `[review]`      |
| `d077772f8` | fix(support): restore hover message for gated priority options (#14320)                      | cloud/support entitlement       |
| `482d6b9da` | fix(web-callouts): remove env var gate (#14286)                                              | cloud marketing gate `[review]` |

## not-applicable (CI / tooling / deploy-env)

| Commit      | Subject                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `222e047a4` | fix(agents): avoid boolean dry-run choice (#14413)                      |
| `5338972a4` | fix(agents): add model price audit dry run (#14412)                     |
| `6d90ef28f` | fix(ci-model-prices): max turns check (#14411)                          |
| `d7726ba5d` | fix(ci-model-price-audit): max turns check (#14410)                     |
| `604422056` | fix(worker): resolve real ECS host id instead of os.hostname() (#14386) |
| `3483c8ada` | fix(seeder): align agentic seed summaries (#14209)                      |

---

## Follow-ups

1. Work the `must-port — high priority` block first (silent failures + auth +
   security), then build/validation, then UI.
2. For each `greptime-rewrite` item, read the CH patch and decide whether the
   underlying concern reproduces on Greptime before writing an adaptation.
   `de483b32b` (timestamp-bound pruning) overlaps the fork's known sessions
   time-bound work and is the highest-value one to evaluate.
3. Resolve every `[review]` tag by reading the diff before porting.
4. Triage the 112 untriaged `feat`/`chore`/`docs`/`ci` commits — at minimum scan
   `feat` for security/correctness changes.
5. Update this ledger as items move to `done`, and bump the scanned range when
   the fork rebases onto a newer upstream tag.
