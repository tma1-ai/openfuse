# Database Patterns - PostgreSQL & GreptimeDB

Complete guide to database access patterns in Langfuse using PostgreSQL (Prisma ORM) and GreptimeDB (direct SQL via mysql2).

## Table of Contents

- [Database Architecture Overview](#database-architecture-overview)
- [PostgreSQL with Prisma](#postgresql-with-prisma)
- [GreptimeDB with Direct Client](#greptimedb-with-direct-client)
- [Repository Pattern](#repository-pattern)
- [When to Use Which Database](#when-to-use-which-database)
- [Error Handling](#error-handling)

---

## Database Architecture Overview

Langfuse uses a **dual database architecture**:

| Database       | Technology         | Purpose                                                       | Access Pattern                          |
| -------------- | ------------------ | ------------------------------------------------------------- | --------------------------------------- |
| **PostgreSQL** | Prisma ORM         | Transactional data, relational data, CRUD operations          | Type-safe ORM with migrations           |
| **GreptimeDB** | Direct SQL (mysql2) | Analytics data, high-volume traces/observations, aggregations | Raw SQL queries with streaming support  |
| **Redis**      | ioredis            | Queues (BullMQ), caching, rate limiting                       | Direct client access                    |

**Key Principle**: Use PostgreSQL for transactional data and relationships. Use GreptimeDB for high-volume analytics and time-series data.

**Event-sourced storage model**: GreptimeDB is event-sourced. `raw_events` (an `append_mode` table) is the source of truth. The `traces`, `observations`, `scores`, and `dataset_run_items` tables are `merge_mode=last_non_null` projection tables, rebuilt by replaying `raw_events`. There is no ClickHouse-style `FINAL` or `LIMIT 1 BY` — the projection tables already hold the merged latest state. `metadata`/`tags` JSON columns on the projection tables are display-only; filtering by metadata/tag goes through EAV subtables `<table>_metadata` / `<table>_tags` via a semijoin (see [GreptimeDB Query Best Practices](#greptimedb-query-best-practices)).

**⚠️ Important**: All queries must filter by `project_id` (or `projectId`) to ensure proper data isolation between tenants. This is essential for the multi-tenant architecture.

---

## PostgreSQL with Prisma

### Import Pattern

```typescript
import { prisma } from "@langfuse/shared/src/db";

// Direct access to Prisma client
const user = await prisma.user.findUnique({ where: { id } });
```

**Important**: Always import from `@langfuse/shared/src/db`, not `@prisma/client` directly.

### Common CRUD Operations

**⚠️ ALWAYS include `projectId` in WHERE clauses** for project-scoped data:

```typescript
// Create
const project = await prisma.project.create({
  data: {
    name: "My Project",
    orgId: organizationId,
  },
});

// ✅ GOOD: Read with projectId filter
const trace = await prisma.trace.findUnique({
  where: { id: traceId, projectId }, // ← Always include projectId for tenant isolation
  include: {
    scores: true,
    project: { select: { id: true, name: true } },
  },
});

// ❌ BAD: Missing projectId filter
// const trace = await prisma.trace.findUnique({
//   where: { id: traceId },  // ← Missing projectId!
// });

// Update
await prisma.user.update({
  where: { id: userId },
  data: { lastLogin: new Date() },
});

// ✅ GOOD: Delete with projectId
await prisma.apiKey.delete({
  where: { id: apiKeyId, projectId }, // ← Always include projectId
});

// ✅ GOOD: Count with projectId
const traceCount = await prisma.trace.count({
  where: { projectId, userId }, // ← Always include projectId
});
```

### Transactions

Use Prisma interactive transactions for operations that must be atomic:

```typescript
const result = await prisma.$transaction(async (tx) => {
  const user = await tx.user.create({ data: userData });

  const project = await tx.project.create({
    data: {
      name: "Default Project",
      orgId: user.id,
    },
  });

  await tx.projectMembership.create({
    data: {
      userId: user.id,
      projectId: project.id,
      role: "OWNER",
    },
  });

  return { user, project };
});
```

**Transaction options:**

```typescript
await prisma.$transaction(
  async (tx) => {
    // Transaction logic
  },
  {
    maxWait: 5000, // Max time to wait for transaction to start (ms)
    timeout: 10000, // Max time transaction can run (ms)
  },
);
```

### Query Optimization

**Use `select` to limit fields:**

```typescript
// ❌ Fetches all fields (including large JSON columns)
const traces = await prisma.trace.findMany({ where: { projectId } });

// ✅ Only fetch needed fields
const traces = await prisma.trace.findMany({
  where: { projectId },
  select: {
    id: true,
    name: true,
    timestamp: true,
    userId: true,
  },
});
```

**Prevent N+1 queries with `include`:**

```typescript
// ❌ N+1 Query Problem
const projects = await prisma.project.findMany();
for (const project of projects) {
  // N additional queries
  const memberCount = await prisma.projectMembership.count({
    where: { projectId: project.id },
  });
}

// ✅ Use include or aggregation
const projects = await prisma.project.findMany({
  include: {
    members: { select: { userId: true, role: true } },
  },
});
```

**Pagination:**

```typescript
const PAGE_SIZE = 50;

const traces = await prisma.trace.findMany({
  where: { projectId },
  orderBy: { timestamp: "desc" },
  take: PAGE_SIZE,
  skip: page * PAGE_SIZE,
});
```

## GreptimeDB with Direct Client

### Import Pattern

```typescript
import { greptimeQuery } from "@langfuse/shared/src/server";
```

Everything is exported from `@langfuse/shared/src/server`. The implementation
lives in `packages/shared/src/server/greptime/client.ts`.

### No Singleton Client

There is **no** singleton client object. You do not "get a client" — you call
`greptimeQuery(...)` directly, and it routes to a managed connection pool.
Pass `readOnly: true` for read queries; the call is then routed to the
read-only pool (which targets `GREPTIME_SQL_READ_ONLY_HOST` when configured,
otherwise the primary SQL endpoint).

```typescript
import { greptimeQuery } from "@langfuse/shared/src/server";

// Read query → read-only pool
const rows = await greptimeQuery({ query, params, readOnly: true });
```

### Query Patterns

GreptimeDB queries use **raw SQL** with **mysql2 placeholders**: `:name` for
named parameters or `?` for positional. This is **not** the old ClickHouse
`{name: Type}` syntax — there are no inline type annotations.

**⚠️ Important**: All GreptimeDB queries must include a `project_id` filter to
ensure proper tenant isolation.

**Simple query:**

```typescript
import {
  greptimeQuery,
  convertDateToDbDateTime,
} from "@langfuse/shared/src/server";

// ✅ GOOD: Always filter by project_id
const rows = await greptimeQuery<{ id: string; name: string }>({
  query: `
    SELECT id, name, timestamp
    FROM traces
    WHERE project_id = :projectId  -- ← REQUIRED: Always filter by project_id
    AND timestamp >= :startTime
    ORDER BY timestamp DESC
    LIMIT :limit
  `,
  params: {
    projectId, // ← Required for tenant isolation
    startTime: convertDateToDbDateTime(startDate),
    limit: 100,
  },
  readOnly: true,
  tags: { feature: "tracing", type: "trace" },
});

// ❌ BAD: Missing project_id filter
// const rows = await greptimeQuery({
//   query: `SELECT * FROM traces WHERE timestamp >= :startTime`,
//   params: { startTime },
// });
```

**Streaming query (for large result sets):**

```typescript
import { greptimeQueryStream } from "@langfuse/shared/src/server";

// Async generator — stream results to avoid loading all rows in memory
for await (const row of greptimeQueryStream<ObservationRecordReadType>({
  query: `
    SELECT *
    FROM observations
    WHERE project_id = :projectId
    AND start_time >= :startTime
  `,
  params: { projectId, startTime },
  readOnly: true,
})) {
  // Process row by row
  await processObservation(row);
}
```

For checkpoint/resume exports (where a stream must survive restarts and pick up
where it left off), use `greptimeKeysetScan` instead of a plain stream.

**Writes:**

Writes do **not** go through `greptimeQuery`. There is no `upsert` helper on the
read client.

- **Bulk ingestion** is owned by the worker's `GreptimeWriter` singleton
  (`worker/src/services/GreptimeWriter`). It is **worker-internal** — it is
  fed from the `raw_events` replay flow in
  `worker/src/queues/ingestionQueue.ts` and is **not** importable from
  `@langfuse/shared`. Application code never calls it directly.
- **Low-frequency single-entity edits** (e.g. a tRPC/UI mutation that updates
  one trace or one score) use the mutation helpers
  `upsertTraceToGreptime` / `upsertScoreToGreptime` from
  `packages/shared/src/server/repositories/greptime/mutations.ts`. These write
  one `raw_events` row, which the projection tables then reflect.

```typescript
import { upsertTraceToGreptime } from "@langfuse/shared/src/server/repositories/greptime/mutations";

await upsertTraceToGreptime({
  id: traceId,
  project_id: projectId,
  timestamp: new Date(),
  name: "API Call",
  user_id: userId,
  // ... other fields
});
```

**DDL / schema:**

There is no runtime DDL helper. Schema is **static SQL** in
`packages/shared/greptime/migrations/*.sql`, applied at startup by
`applyGreptimeMigrations` (`packages/shared/src/server/greptime/applyMigrations.ts`).
Application code never issues `ALTER TABLE` at runtime.

### Date / Parameter Handling

GreptimeDB uses native mysql2 type binding, so JavaScript values map directly —
no per-parameter type annotations.

**Date handling:**

```typescript
import { convertDateToDbDateTime } from "@langfuse/shared/src/server";

const params = {
  startTime: convertDateToDbDateTime(new Date()),
};
```

To parse a DB UTC datetime string back into a `Date`, use
`parseDbUtcDateTimeFormat` (from `repositories/dbUtils`).

### GreptimeDB Query Best Practices

**1. Always filter by `project_id` for tenant isolation:**

```typescript
// ✅ CORRECT: project_id filter is required
const query = `
  SELECT *
  FROM traces
  WHERE project_id = :projectId  -- ← Required for tenant isolation
  AND timestamp >= :startTime
`;

// ❌ WRONG: Missing project_id filter
// const query = `
//   SELECT * FROM traces WHERE timestamp >= :startTime
// `;
```

**Why this is important:**

- Langfuse is multi-tenant - each project's data must be isolated
- The `project_id` filter ensures queries only access data from the intended tenant
- All queries on project-scoped tables (traces, observations, scores, sessions, etc.) must filter by `project_id`

**2. No deduplication step needed.**

The projection tables (`traces`, `observations`, `scores`,
`dataset_run_items`) are `merge_mode=last_non_null`. They already hold the
merged latest state, so there is **no** ClickHouse-style `FINAL` /
`LIMIT 1 BY id, project_id` to write. Query the projection table directly:

```typescript
const query = `
  SELECT *
  FROM traces
  WHERE project_id = :projectId
  AND id IN (:traceIds)
`;
```

**3. Filtering by metadata or tags uses EAV subtables.**

The `metadata` / `tags` JSON columns on the projection tables are
**display-only**. To filter on a metadata key/value or a tag, semijoin against
the EAV subtable `<table>_metadata` / `<table>_tags`:

```typescript
const query = `
  SELECT *
  FROM traces
  WHERE project_id = :projectId
  AND id IN (
    SELECT entity_id FROM traces_metadata
    WHERE project_id = :projectId
    AND key = :metaKey
    AND value LIKE :metaValue
  )
`;
```

The subtable query must filter `project_id` too.

**4. Use time-based filtering for performance:**

```typescript
// Combine project_id filter with timestamp for optimal performance
const query = `
  SELECT *
  FROM observations
  WHERE project_id = :projectId  -- ← Required for tenant isolation
  AND start_time >= :startTime  -- ← Improves performance
  AND start_time < :endTime
`;
```

**5. Use CTEs for complex queries (still require `project_id`):**

```typescript
const query = `
  WITH observations_agg AS (
    SELECT
      trace_id,
      count() as observation_count,
      sum(total_cost) as total_cost
    FROM observations
    WHERE project_id = :projectId  -- ← Filter in CTE
    GROUP BY trace_id
  )
  SELECT
    t.id,
    t.name,
    o.observation_count,
    o.total_cost
  FROM traces t
  LEFT JOIN observations_agg o ON t.id = o.trace_id
  WHERE t.project_id = :projectId  -- ← Filter in main query
`;
```

**Note**: When using CTEs or subqueries, ensure `project_id` filter is applied at each level.

**Error handling with retries:**

GreptimeDB queries automatically retry on transient network errors. Custom
error handling for resource limits:

```typescript
import {
  greptimeQuery,
  DbResourceError,
} from "@langfuse/shared/src/server";

try {
  const rows = await greptimeQuery({ query, params, readOnly: true });
} catch (error) {
  if (error instanceof DbResourceError) {
    // Memory limit, timeout, or overcommit error
    throw new Error(DbResourceError.ERROR_ADVICE_MESSAGE);
  }
  throw error;
}
```

---

## Repository Pattern

Langfuse uses repositories in `packages/shared/src/server/repositories/` for complex data access patterns.

### When to Use Repositories

✅ **Use repositories when:**

- Complex GreptimeDB queries with CTEs, aggregations, or joins
- Query used in multiple places (DRY principle)
- Need data transformation/converters (DB → domain models)
- Building reusable query logic with filters

❌ **Use direct Prisma/`greptimeQuery` for:**

- Simple CRUD operations
- One-off queries
- Prototyping (refactor to repository later)

The read repositories `repositories/traces.ts`, `repositories/scores.ts`, and
`repositories/observations.ts` are thin entry points — they delegate to the
GreptimeDB query builders under `repositories/greptime/*`.

### Repository Examples

**Trace repository (GreptimeDB):**

```typescript
// packages/shared/src/server/repositories/traces.ts
export const getTracesByIds = async (
  projectId: string,
  traceIds: string[],
): Promise<TraceRecordReadType[]> => {
  // Projection table already holds merged latest state — no FINAL / LIMIT 1 BY.
  const rows = await greptimeQuery<TraceRecordReadType>({
    query: `
      SELECT *
      FROM traces
      WHERE project_id = :projectId
      AND id IN (:traceIds)
    `,
    params: { projectId, traceIds },
    readOnly: true,
    tags: { feature: "tracing", type: "trace" },
  });

  return rows.map(convertGreptimeToDomain);
};
```

**Score repository (PostgreSQL + GreptimeDB):**

```typescript
// Repositories can query both databases
export const getScoresByTraceId = async (
  projectId: string,
  traceId: string,
) => {
  // Use GreptimeDB for analytics
  const greptimeScores = await greptimeQuery<ScoreRecordReadType>({
    query: `
      SELECT *
      FROM scores
      WHERE project_id = :projectId
      AND trace_id = :traceId
    `,
    params: { projectId, traceId },
    readOnly: true,
  });

  // Use Prisma for config data
  const scoreConfigs = await prisma.scoreConfig.findMany({
    where: { projectId },
  });

  return enrichScoresWithConfigs(greptimeScores, scoreConfigs);
};
```

---

## When to Use Which Database

| Use Case                               | Database   | Reasoning                                  |
| -------------------------------------- | ---------- | ------------------------------------------ |
| User accounts, projects, API keys      | PostgreSQL | Transactional data with strong consistency |
| Prompt management, dataset definitions | PostgreSQL | Configuration data with relations          |
| Project settings, RBAC permissions     | PostgreSQL | Small, frequently updated data             |
| Traces, observations, events           | GreptimeDB | High-volume time-series data               |
| Score aggregations, analytics queries  | GreptimeDB | Fast aggregations over millions of rows    |
| Usage metrics, cost calculations       | GreptimeDB | Analytical queries with GROUP BY           |
| Exports, large dataset queries         | GreptimeDB | Streaming support for large result sets    |

**Decision flow:**

1. Is it high-volume time-series data? → **GreptimeDB**
2. Does it need aggregation over millions of rows? → **GreptimeDB**
3. Is it transactional data with relationships? → **PostgreSQL**
4. Is it configuration or user data? → **PostgreSQL**
5. Is it frequently updated? → **PostgreSQL**
6. Is it append-only analytics data? → **GreptimeDB**

### Project-Scoped vs Global Tables

**Project-scoped tables (MUST filter by `project_id`):**

- `raw_events` - The append-only source of truth; queries require `project_id`
- `traces` - All trace queries require `project_id`
- `observations` - All observation queries require `project_id`
- `scores` - All score queries require `project_id`
- `dataset_run_items` - All dataset run queries require `project_id`

**Global tables (no `project_id` filter needed):**

- `users` - User management (use `id` for filtering)
- `organizations` - Organization data (use `id` for filtering)
- System configuration tables

**Example of correct filtering:**

```typescript
// ✅ CORRECT: Project-scoped query
const traces = await greptimeQuery({
  query: `
    SELECT * FROM traces
    WHERE project_id = :projectId
    AND timestamp >= :startTime
  `,
  params: { projectId, startTime },
  readOnly: true,
});

// ✅ CORRECT: Global table query (no project_id needed)
const user = await prisma.user.findUnique({
  where: { id: userId },
});

// ❌ WRONG: Project-scoped query without project_id filter
// const traces = await greptimeQuery({
//   query: `SELECT * FROM traces WHERE timestamp >= :startTime`,
// });
```

---

## Error Handling

### PostgreSQL (Prisma) Errors

```typescript
import { Prisma } from "@prisma/client";
import { prisma } from "@langfuse/shared/src/db";

try {
  await prisma.user.create({ data: userData });
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Unique constraint violation
    if (error.code === "P2002") {
      const target = error.meta?.target as string[];
      throw new ConflictError(`${target?.join(", ")} already exists`);
    }

    // Foreign key constraint
    if (error.code === "P2003") {
      throw new ValidationError("Invalid reference");
    }

    // Record not found
    if (error.code === "P2025") {
      throw new NotFoundError("Record not found");
    }

    // Record required to connect not found
    if (error.code === "P2018") {
      throw new ValidationError("Related record not found");
    }
  }

  // Unknown error
  logger.error("Prisma error", { error });
  throw error;
}
```

**Common Prisma error codes:**

| Code    | Meaning                     | Typical Cause                          |
| ------- | --------------------------- | -------------------------------------- |
| `P2002` | Unique constraint violation | Duplicate email, API key, etc.         |
| `P2003` | Foreign key constraint      | Referenced record doesn't exist        |
| `P2025` | Record not found            | Update/delete of non-existent record   |
| `P2018` | Required relation not found | Connect to non-existent related record |

### GreptimeDB Errors

```typescript
import {
  greptimeQuery,
  DbResourceError,
} from "@langfuse/shared/src/server";

try {
  const rows = await greptimeQuery({ query, params, readOnly: true });
} catch (error) {
  // Resource errors (memory limit, timeout, overcommit)
  if (error instanceof DbResourceError) {
    logger.warn("GreptimeDB resource error", {
      errorType: error.errorType, // "MEMORY_LIMIT" | "OVERCOMMIT" | "TIMEOUT"
      message: error.message,
    });

    // User-friendly error message
    throw new BadRequestError(DbResourceError.ERROR_ADVICE_MESSAGE);
  }

  // Network/connection errors are automatically retried
  logger.error("GreptimeDB error", { error });
  throw error;
}
```

**GreptimeDB resource error types:**

| Error Type     | Meaning                     | Solution                                          |
| -------------- | --------------------------- | ------------------------------------------------- |
| `MEMORY_LIMIT` | Query used too much memory  | Use more specific filters or shorter time range   |
| `OVERCOMMIT`   | Memory overcommit limit hit | Reduce query complexity or result set size        |
| `TIMEOUT`      | Query took too long         | Add filters, reduce time range, or optimize query |

`DbResourceError` carries a static `ERROR_ADVICE_MESSAGE` and the
`errorType` discriminator above.

---

**Related Files:**

- [../SKILL.md](../SKILL.md) - Main backend development guidelines
- [architecture-overview.md](architecture-overview.md) - System architecture
- [configuration.md](configuration.md) - Environment variable configuration
