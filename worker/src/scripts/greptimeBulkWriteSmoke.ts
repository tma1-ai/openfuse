/**
 * Empirical gate for the P1 Arrow Flight bulk backfill design. Run against a live GreptimeDB:
 *   GREPTIME_GRPC_URL=localhost:4001 GREPTIME_SQL_HOST=localhost GREPTIME_SQL_PORT=4002 \
 *     npx tsx worker/src/scripts/greptimeBulkWriteSmoke.ts
 *
 * Proves the routing facts the bulk plan hinges on:
 *   1. A decimal-free EAV table accepts a bulk DoPut built from the client `Table.schema()` even
 *      though the client column order differs from the server's physical order -> the server matches
 *      Arrow fields by NAME, not position.
 *   2. The observations table (3x DECIMAL(38,12)) is rejected on the bulk path -> Decimal128 stays on
 *      the unary writer.
 *   3. Whether the JSON-bearing projection tables (traces / scores / dataset_run_items) ride bulk at
 *      all. `DataType.Json` columns are serialized to JSON *strings* by `jsonOrNull` before the write,
 *      so this checks the bulk Arrow encoder accepts a string for a Json column. The PASS/FAIL set
 *      below is what feeds the `BULK_SUPPORTED` allowlist in GreptimeBulkWriter.
 */
import {
  getGreptimeIngestClient,
  greptimeQuery,
  closeGreptimeConnections,
  usageCostTable,
  observationsTable,
  tracesTable,
  scoresTable,
  datasetRunItemsTable,
} from "@langfuse/shared/src/server";
import type { Table, TableSchema } from "@greptime/ingester";

const PROJECT = `bulk-smoke-${Date.now()}`;
let failures = 0;
const bulkOk: string[] = [];
const bulkRejected: string[] = [];
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failures++;
};

// Build a positional row array in the client schema's column order, from a name->value map.
const rowFor = (
  schema: TableSchema,
  values: Record<string, unknown>,
): unknown[] => schema.columns.map((c) => values[c.name] ?? null);

async function testEavBulk() {
  const client = getGreptimeIngestClient();
  const table = usageCostTable("observations_usage_cost");
  const schema = table.schema();
  console.log(
    `EAV client schema column order: [${schema.columns.map((c) => c.name).join(", ")}]`,
  );

  const ts = Date.now();
  const rows = [
    rowFor(schema, {
      project_id: PROJECT,
      entity_id: "obs-1",
      kind: "usage",
      key: "cache_read",
      timestamp: ts,
      value: 11,
      is_deleted: false,
    }),
    rowFor(schema, {
      project_id: PROJECT,
      entity_id: "obs-1",
      kind: "cost",
      key: "cache_read",
      timestamp: ts,
      value: 0.5,
      is_deleted: false,
    }),
  ];

  const writer = await client.createBulkStreamWriter(schema);
  await writer.writeRows({ kind: "rows", rows });
  const summary = await writer.finish();
  check(
    "EAV bulk finish reports 2 affected rows",
    summary.totalAffectedRows === 2,
    summary,
  );

  const read = await greptimeQuery<{
    key: string;
    value: number;
    kind: string;
  }>({
    query: `SELECT kind, \`key\`, value FROM observations_usage_cost WHERE project_id = :p ORDER BY kind`,
    params: { p: PROJECT },
  });
  check("EAV bulk rows landed and are readable", read.length === 2, read);
  check(
    "EAV bulk value preserved (name-matched, not position-mangled)",
    read.some((r) => r.kind === "usage" && Number(r.value) === 11) &&
      read.some((r) => r.kind === "cost" && Number(r.value) === 0.5),
    read,
  );
  bulkOk.push("observations_usage_cost");

  await greptimeQuery({
    query: `DELETE FROM observations_usage_cost WHERE project_id = ?`,
    params: [PROJECT],
  });
}

async function testObservationsBulkRejected() {
  const client = getGreptimeIngestClient();
  const schema = observationsTable().schema();
  try {
    await client.createBulkStreamWriter(schema);
    check(
      "observations bulk should be rejected (has DECIMAL columns)",
      false,
      "createBulkStreamWriter unexpectedly succeeded",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(
      "observations bulk rejected with a Decimal128 error",
      /Decimal128/i.test(msg),
      msg,
    );
  }
}

/**
 * Drive a full bulk round-trip (createBulkStreamWriter -> writeRows -> finish -> read back) for a
 * JSON-bearing projection table and record whether the table rides bulk. A throw anywhere (schema
 * handshake or per-batch ack) is treated as "not bulk-supported", not a hard test failure — the point
 * is to *learn* the allowlist, not to assert success.
 */
async function probeProjectionBulk(params: {
  name: string;
  table: Table;
  idColumn: string; // tag column carrying the entity id (besides project_id)
  values: Record<string, unknown>;
}) {
  const client = getGreptimeIngestClient();
  const { name, table, idColumn, values } = params;
  const schema = table.schema();
  try {
    const writer = await client.createBulkStreamWriter(schema);
    await writer.writeRows({ kind: "rows", rows: [rowFor(schema, values)] });
    const summary = await writer.finish();
    const read = await greptimeQuery<Record<string, unknown>>({
      query: `SELECT \`${idColumn}\` FROM ${name} WHERE project_id = :p`,
      params: { p: PROJECT },
    });
    const ok = summary.totalAffectedRows === 1 && read.length === 1;
    check(`${name} bulk round-trip (JSON columns ride bulk)`, ok, {
      summary,
      read,
    });
    if (ok) bulkOk.push(name);
    else bulkRejected.push(name);
    await greptimeQuery({
      query: `DELETE FROM ${name} WHERE project_id = ?`,
      params: [PROJECT],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`INFO  ${name} bulk NOT supported -> ${msg}`);
    bulkRejected.push(name);
  }
}

async function testProjectionTablesBulk() {
  const ts = Date.now();
  // traces: tags + metadata are DataType.Json, fed JSON strings (jsonOrNull output shape).
  await probeProjectionBulk({
    name: "traces",
    table: tracesTable(),
    idColumn: "id",
    values: {
      project_id: PROJECT,
      id: "trace-1",
      timestamp: ts,
      name: "smoke-trace",
      environment: "default",
      tags: JSON.stringify(["a", "b"]),
      metadata: JSON.stringify({ k: "v" }),
      bookmarked: false,
      public: false,
      created_at: ts,
      updated_at: ts,
      is_deleted: false,
    },
  });

  // scores: metadata is Json; value is Float64.
  await probeProjectionBulk({
    name: "scores",
    table: scoresTable(),
    idColumn: "id",
    values: {
      project_id: PROJECT,
      id: "score-1",
      timestamp: ts,
      name: "smoke-score",
      environment: "default",
      source: "API",
      data_type: "NUMERIC",
      value: 0.75,
      metadata: JSON.stringify({ k: "v" }),
      created_at: ts,
      updated_at: ts,
      is_deleted: false,
    },
  });

  // dataset_run_items: dataset_run_metadata + dataset_item_metadata are Json.
  await probeProjectionBulk({
    name: "dataset_run_items",
    table: datasetRunItemsTable(),
    idColumn: "id",
    values: {
      project_id: PROJECT,
      id: "dri-1",
      dataset_run_created_at: ts,
      dataset_id: "ds-1",
      dataset_run_id: "run-1",
      dataset_item_id: "item-1",
      dataset_run_metadata: JSON.stringify({ k: "v" }),
      dataset_item_metadata: JSON.stringify({ k: "v" }),
      created_at: ts,
      updated_at: ts,
      is_deleted: false,
    },
  });
}

async function main() {
  await testEavBulk();
  await testObservationsBulkRejected();
  await testProjectionTablesBulk();
  await closeGreptimeConnections();

  console.log(`\n=== BULK ROUTING SUMMARY ===`);
  console.log(`bulk OK:       ${bulkOk.join(", ") || "(none)"}`);
  console.log(`bulk rejected: ${bulkRejected.join(", ") || "(none)"}`);
  console.log(
    `\nBULK_SUPPORTED should include: observations_usage_cost + all "bulk OK" projection tables.`,
  );
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
