# Open Source Pre-Release Readiness Report

> Review date: 2026-06-20  
> Scope: public open-source release readiness for the GreptimeDB-backed Langfuse fork  
> Related technical audit: [`05-review-report.md`](05-review-report.md)

## Executive Summary

The project is much closer to a release candidate at the migration-core level than
the public-facing repository suggests. The GreptimeDB storage migration is mostly
in place: product backend ClickHouse call sites are removed, GreptimeDB owns
`raw_events` and projections, the read path is substantially migrated, deletion
and replay behavior exists, and PR #41 has landed the bulk Arrow Flight backfill
writer on `main`.

That does not make the project ready as a public open-source release.

The remaining gap is mostly not feature implementation. It is trust, packaging,
identity, first-run reliability, and contributor clarity. Today an external user
would see a stale README, upstream Langfuse contribution links, an upstream
security contact, hidden deployment docs, and unclear project naming. That makes
the project look less complete and less reliable than the code actually is.

Recommended release posture:

> Developer preview / alpha: a Langfuse-compatible, self-hosted LLM observability
> stack backed by GreptimeDB.

Do not position it as stable yet.

## Release Readiness Verdict

| Area | Status | Release impact |
| --- | ---: | --- |
| Core GreptimeDB migration | Mostly ready | Good enough for alpha, pending known limitations |
| Public README | Not ready | Blocks external adoption |
| First-run deployment path | Partially ready | Needs simpler, harder-to-misuse quickstart |
| Docker image publishing | Mostly ready | Workflow exists, but not documented as user-facing install path |
| Project identity | Not ready | Naming is inconsistent across docs, images, env vars, and package metadata |
| Contributor docs | Not ready | Still route contributors to upstream Langfuse surfaces |
| Security policy | Not ready | Still uses upstream Langfuse security contact |
| Known limitations | Not ready | Technical gaps exist but are buried in migration review docs |
| Operations docs | Partially ready | Compaction/runbook exists, but needs public release framing |
| CI confidence | Reasonable for alpha | Needs full Compose smoke test and release-image validation |

Bottom line: publish after a docs/governance/release-packaging pass, not before.

## Blocking Gaps Before Public Pre-Release

### 1. README Is Stale and Undersells the Project

`README.md` still says the project is "work in progress", only the ingestion
write path is implemented, and the project should not be used in production. It
also still says local development uses ClickHouse and MinIO as the default
analytics stack.

This now contradicts the migration state:

- GreptimeDB schema, raw event store, projections, and EAV tables exist.
- Write path and replay are implemented.
- Read path coverage is much broader than "planned".
- Dashboard, dataset, experiment, deletion, and reconciliation paths have been
  substantially migrated.
- PR #41 has landed the bulk Arrow Flight backfill writer on `main`.
- The Docker Compose stack includes GreptimeDB and makes object storage optional.

The README should be replaced, not lightly patched.

Minimum content:

- What the project is.
- Current release status: alpha / developer preview.
- What works today.
- Known limitations.
- 5-minute Docker Compose quickstart.
- Published Docker image names and tag policy.
- GreptimeDB architecture summary.
- Compatibility statement for existing Langfuse SDKs and APIs.
- Link to deployment, development, operations, and migration docs.

### 2. Contributor Docs Still Belong to Upstream Langfuse

`CONTRIBUTING.md` still points to upstream Langfuse issues, discussions, Discord,
docs, and SDK repositories. Its network diagram still describes ClickHouse as
the observability data store.

For a public fork, this is actively misleading. Contributors will open issues in
the wrong place, follow the wrong local setup, and reason about the wrong
storage architecture.

Minimum replacement:

- Project-specific contribution channels.
- Development setup using Postgres, Redis, GreptimeDB, and optional MinIO.
- How to bootstrap GreptimeDB schema locally.
- How to run targeted GreptimeDB tests.
- Which upstream Langfuse changes should be ported.
- Which GreptimeDB-specific areas need help.
- PR expectations for migration-sensitive changes.

### 3. Security Policy Points to the Wrong Project

`SECURITY.md` still tells users to use upstream Langfuse security guidance and
contact `security@langfuse.com`.

This must be fixed before any public release. Security reporters need a correct
private contact and a clear supported-version policy.

Minimum replacement:

- Security contact for this fork.
- Supported release line or "latest pre-release only" policy.
- What is in scope: fork code, GreptimeDB integration, deployment templates,
  Docker images, and public API behavior.
- What is out of scope: upstream Langfuse Cloud, upstream SDK repositories, and
  unrelated GreptimeDB server vulnerabilities unless triggered by this fork.
- Expected acknowledgement and remediation cadence.

### 4. Deployment Docs Are Good but Hidden

`docs/greptimedb-migration/07-deployment.md` has useful deployment information:
GreptimeDB endpoints, environment variables, optional object storage, schema
bootstrap, Docker Compose, and pending validation.

The problem is placement and framing. A new user should not have to discover
deployment guidance inside migration notes.

Recommended user-facing doc layout:

- `docs/deployment.md`
- `docs/development.md`
- `docs/architecture.md`
- `docs/known-limitations.md`
- `docs/operations.md`
- `docs/migration-from-langfuse.md`

Keep `docs/greptimedb-migration/*` as engineering history and design record.
Promote the stable parts into user-facing docs.

### 5. First-Run Path Is Too Easy to Misorder

The current deployment flow requires:

1. Start GreptimeDB, Postgres, and Redis.
2. Run `pnpm --filter=@langfuse/shared run greptime:migrate`.
3. Start web and worker.

This is acceptable for maintainers, but weak for an open-source self-hosted
experience. Users can start containers in the wrong order or miss the GreptimeDB
schema bootstrap entirely.

Recommended fixes:

- Add a documented one-command local self-host path, such as `make up` or
  `pnpm run selfhost:up`.
- Or make container startup run GreptimeDB migrations with a cross-process lock.
- At minimum, make the README quickstart explicit and hard to misread.
- Add a post-start health check that tells the user when GreptimeDB schema is
  missing, rather than failing later in the product path.

### 6. Docker Image Publishing Exists but Is Not Productized

`.github/workflows/release-images.yml` builds and publishes:

- `tma1ai/openfuse-web`
- `tma1ai/openfuse-worker`

The workflow has a reasonable tag model: semver tags, `latest` for non-RC
version tags, commit SHA tags, and manual tags. But the README does not expose
this as the primary install path.

Before public release:

- Confirm final Docker Hub organization and image names.
- Document image tags.
- Add a Compose example using published images instead of local build.
- Decide whether `latest` should exist for alpha releases.
- Add a smoke test that runs the published images against the Compose stack.

### 7. Project Identity Is Inconsistent

Current repository language mixes:

- "Langfuse on GreptimeDB"
- "openfuse"
- `OPENFUSE_WEB_IMAGE`
- package name `langfuse`
- upstream Langfuse copyright and branding

This is understandable during migration, but not acceptable for a clean public
release. Users need to know what the project is called, who maintains it, and how
it relates to Langfuse.

Decide and apply consistently:

- Public project name.
- GitHub repository name.
- Docker image names.
- README title.
- Package/release naming.
- Legal attribution to upstream Langfuse.
- How the project describes compatibility without implying upstream ownership.

### 8. Known Limitations Need a Public Page

The technical review already identifies remaining gaps:

- Dashboard/widget tool introspection filters are not yet supported.
- `dataset_run_items` deletion semantics are a documented source-of-truth
  exception unless tombstones are added.
- Backfill and large-query performance depend on compaction/SST state.
- Substring search uses scan-prone `LIKE`; indexed full-text search is term
  based.
- GreptimeDB migrations currently rely on idempotent DDL and have no migration
  ledger.

These are acceptable for alpha if they are visible. They are not acceptable if
users only discover them after deploying.

Create `docs/known-limitations.md` and link it from the README.

## Strongly Recommended Before Alpha

These are not all hard blockers, but they materially affect first-user trust.

### Full Compose Smoke Test

Run the complete first-run path from a clean checkout:

1. Copy `.env.prod.example` to `.env`.
2. Set required secrets.
3. Start GreptimeDB, Postgres, and Redis.
4. Bootstrap GreptimeDB schema.
5. Start web and worker.
6. Create an org/project/user.
7. Ingest a trace using an existing Langfuse SDK.
8. Confirm trace, observation, score, dashboard, and deletion flows.
9. Restart the stack and confirm data survives.

This should become a release checklist item.

### Image-Based Smoke Test

Local builds are not enough. The release path should verify the published images:

- Pull `tma1ai/openfuse-web:<tag>`.
- Pull `tma1ai/openfuse-worker:<tag>`.
- Run them through `docker-compose.yml`.
- Confirm the same ingest/read/delete smoke path.

### Public Architecture Doc

Add a plain architecture doc with one diagram:

- Web
- Worker
- Postgres
- Redis
- GreptimeDB
- Optional object storage

Explain what lives in Postgres, what lives in GreptimeDB, what object storage is
still used for, and why ClickHouse is not part of this fork.

### Operations Doc

Promote the compaction runbook into a public operations page:

- Important GreptimeDB metrics.
- When to compact.
- Which tables are hot.
- How backfill affects SST fragmentation.
- Expected alert thresholds.
- What to do after bulk backfill.

### Compatibility Statement

State clearly:

- Which upstream Langfuse version this fork currently tracks.
- Whether existing Langfuse SDKs work unchanged.
- Which APIs are expected to be compatible.
- Which feature surfaces differ from upstream.
- Whether upstream Langfuse migrations can be applied directly.

### Roadmap

Add a short public roadmap:

- Close remaining Langfuse parity gaps.
- Production hardening for backfill and compaction.
- GreptimeDB-native observability improvements.
- Release automation and upgrade path.
- Upstream sync policy.

## Suggested Pre-Release Checklist

### Documentation

- [ ] Replace README with current alpha-ready content.
- [ ] Rewrite CONTRIBUTING for this fork.
- [ ] Rewrite SECURITY for this fork.
- [ ] Add `docs/deployment.md`.
- [ ] Add `docs/development.md`.
- [ ] Add `docs/architecture.md`.
- [ ] Add `docs/known-limitations.md`.
- [ ] Add `docs/operations.md`.
- [ ] Link migration review docs as design history, not primary user docs.

### Release Packaging

- [ ] Decide final public project name.
- [ ] Decide final Docker image names.
- [ ] Decide image tag policy for alpha, RC, and stable.
- [ ] Document published image usage in Compose.
- [ ] Verify release image workflow secrets and permissions.
- [ ] Run image-based Compose smoke test.

### Product and Migration Confidence

- [ ] Run full clean Compose smoke test.
- [ ] Run SDK ingest/read smoke test.
- [ ] Run deletion/replay smoke test.
- [ ] Run dashboard smoke test.
- [ ] Run dataset/experiment smoke test.
- [ ] Run PR #41 bulk backfill drill on realistic data.
- [ ] Run post-backfill compaction and query latency validation.
- [ ] Add or document alerting for GreptimeDB SST fragmentation.

### Governance

- [ ] Set issue templates to this project.
- [ ] Set discussion links to this project.
- [ ] Set code owners or maintainer review policy.
- [ ] Decide how upstream Langfuse changes are tracked and ported.
- [ ] Decide security response ownership.

## Recommended Launch Framing

Use restrained language. Do not present this as a stable replacement yet.

Good framing:

> OpenFUSE is a developer-preview fork of Langfuse that replaces ClickHouse with
> GreptimeDB for the observability event store. It keeps the Langfuse product
> shape and SDK compatibility goals while making GreptimeDB the source of truth
> for traces, observations, scores, and analytics projections.

Avoid claims like:

- "production ready"
- "drop-in replacement" without qualification
- "fully compatible" until dashboard/tool-filter and operational validation gaps
  are closed
- "no object storage needed" without explaining the remaining optional blob/media
  use cases

## Conclusion

The project is not far from a credible public alpha. The migration code is ahead
of the project shell. The next release-critical work should be documentation,
identity, first-run packaging, and explicit limitations, not additional product
surface area.

Once the README, contributing guide, security policy, deployment docs, known
limitations, and Compose/image smoke tests are in place, the project can be
released honestly as a developer preview.
