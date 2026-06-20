-- Tool-name aggregation EAV tables (05-review-report Finding #1).
--
-- Observations carry `tool_definitions` (a dynamic `name -> definition` map) and
-- `tool_call_names` (an array of invoked tool names). The ClickHouse dashboard filtered/grouped
-- these with `mapKeys(tool_definitions)` and `arrayJoin(tool_call_names)`, but GreptimeDB SQL can
-- neither enumerate JSON map keys nor arrayJoin a JSON array inline, so the dashboard tool filters
-- (`toolNames` / `calledToolNames`) had to fail loud (see repositories/greptime/dashboards.ts and
-- features/query/greptimeDataModel.ts).
--
-- These tables materialise the decomposition at write time -- one row per (project, observation,
-- tool_name) -- so a `toolNames` filter becomes an ordinary project-scoped EAV `EXISTS` (mirroring
-- observations_metadata / *_tags) and a by-tool breakdown becomes an ordinary relation join +
-- GROUP BY tool_name (mirroring the `arrayJoin` fan-out). The full maps remain stored verbatim on
-- the observations projection (exact restore); these are derived aggregation indexes, populated and
-- rebuilt by the same fan-out (buildGreptimeRowsForRecord) as the metadata/tags/usage_cost subtables.
--
-- `tool_name` carries an INVERTED INDEX (following 0008's `kind`): it is always equality-filtered
-- (EXISTS predicate) or grouped. The cardinality assumption is unproven for multi-tenant tool sets;
-- validate at scale with EXPLAIN ANALYZE VERBOSE + the liveCheck query and switch to a SKIPPING
-- (bloom) index if tool names turn out to be high-cardinality. `timestamp` holds the observation
-- start_time (same convention as observations_metadata), giving filters/breakdowns a time index to
-- prune on directly.
CREATE TABLE IF NOT EXISTS observations_tool_definitions (
    `timestamp`    TIMESTAMP(3) NOT NULL TIME INDEX,
    `project_id`   STRING NOT NULL,
    `entity_id`    STRING NOT NULL,
    `tool_name`    STRING NOT NULL INVERTED INDEX,
    `is_deleted`   BOOLEAN DEFAULT false,
    PRIMARY KEY (project_id, entity_id, `tool_name`)
) WITH ('merge_mode' = 'last_non_null', 'sst_format' = 'flat');

CREATE TABLE IF NOT EXISTS observations_tool_calls (
    `timestamp`    TIMESTAMP(3) NOT NULL TIME INDEX,
    `project_id`   STRING NOT NULL,
    `entity_id`    STRING NOT NULL,
    `tool_name`    STRING NOT NULL INVERTED INDEX,
    `is_deleted`   BOOLEAN DEFAULT false,
    PRIMARY KEY (project_id, entity_id, `tool_name`)
) WITH ('merge_mode' = 'last_non_null', 'sst_format' = 'flat');
