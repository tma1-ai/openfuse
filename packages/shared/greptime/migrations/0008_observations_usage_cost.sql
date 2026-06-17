-- Long-tail usage/cost key aggregation (F5).
--
-- Observations carry `usage_details` and `cost_details` as dynamic `key -> number` maps with
-- arbitrary project-defined keys (input, output, total, cache_read, reasoning, audio, ...). The
-- ClickHouse backend broke these down per key with `ARRAY JOIN mapKeys/mapValues(..._details)`,
-- but GreptimeDB SQL cannot enumerate JSON keys, so the dashboard by-type-by-time read had to
-- narrow to a hardcoded input/output/total allowlist (see repositories/greptime/dashboards.ts).
--
-- This table materialises the map decomposition at write time -- one row per
-- (project, observation, kind, key) -> value -- so per-custom-key aggregation becomes an ordinary
-- server-side GROUP BY key that scales, mirroring the observations_metadata / *_tags EAV pattern.
-- The full maps remain stored verbatim on the observations projection (exact restore); this table
-- is a derived aggregation index, populated and rebuilt by the same fan-out
-- (buildGreptimeRowsForRecord) as the metadata/tags subtables.
--
-- `kind` is always equality-filtered ('usage' | 'cost'), low cardinality -> INVERTED INDEX.
-- `value` is DOUBLE: matches the dashboard's existing precision (json_get_float -> double) and the
-- metrics byType app-side sum (JS number), so there is no precision change. `timestamp` holds the
-- observation start_time (same convention as observations_metadata), giving the by-type-by-time
-- query a time index to bucket (date_bin) and prune on directly.
CREATE TABLE IF NOT EXISTS observations_usage_cost (
    `timestamp`    TIMESTAMP(3) NOT NULL TIME INDEX,
    `project_id`   STRING NOT NULL,
    `entity_id`    STRING NOT NULL,
    `kind`         STRING NOT NULL INVERTED INDEX,
    `key`          STRING NOT NULL,
    `value`        DOUBLE,
    `is_deleted`   BOOLEAN DEFAULT false,
    PRIMARY KEY (project_id, entity_id, `kind`, `key`)
) WITH ('merge_mode' = 'last_non_null', 'sst_format' = 'flat');
