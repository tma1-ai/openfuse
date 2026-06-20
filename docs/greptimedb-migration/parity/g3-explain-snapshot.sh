#!/usr/bin/env bash
# Gate 3 / G3.1 — EXPLAIN ANALYZE VERBOSE prune snapshot for indexed columns.
# Reads from the fork GreptimeDB (mysql :4002, db openfuse), project smoke-proj, after a scale
# seed + ADMIN compact_table. Sums the v1.1.0 ScanMetricsSet prune metrics across SSTs/regions and
# times each query. Output: a markdown table on stdout.
set -uo pipefail
MYSQL=(mysql -N -h 127.0.0.1 -P 4002 openfuse)
PROJ=smoke-proj

# representative selective values from the seeded data
TRACE=$("${MYSQL[@]}" -e "SELECT id FROM traces WHERE project_id='$PROJ' LIMIT 1;")
USER=$("${MYSQL[@]}" -e "SELECT user_id FROM traces WHERE project_id='$PROJ' AND user_id<>'' LIMIT 1;")
SESS=$("${MYSQL[@]}" -e "SELECT session_id FROM traces WHERE project_id='$PROJ' AND session_id<>'' LIMIT 1;")
SC_TRACE=$("${MYSQL[@]}" -e "SELECT trace_id FROM scores WHERE project_id='$PROJ' AND trace_id<>'' LIMIT 1;")
SC_OBS=$("${MYSQL[@]}" -e "SELECT observation_id FROM scores WHERE project_id='$PROJ' AND observation_id<>'' LIMIT 1;")

sumkey() { # $1=blob $2=key  -> sum of all "key":N occurrences
  echo "$1" | grep -oE "\"$2\":[0-9]+" | grep -oE '[0-9]+$' | awk '{s+=$1} END{print s+0}'
}

row() { # $1=label $2=index_type $3=table $4=where
  local label="$1" itype="$2" tbl="$3" where="$4"
  local blob res ms rgt rgb rgi rgm sstrows resrows
  blob=$("${MYSQL[@]}" -e "EXPLAIN ANALYZE VERBOSE SELECT count(*) FROM $tbl WHERE $where;" 2>&1 | tr ',' '\n')
  rgt=$(sumkey "$blob" rg_total)
  rgb=$(sumkey "$blob" rg_bloom_filtered)
  rgi=$(sumkey "$blob" rg_inverted_filtered)
  rgm=$(sumkey "$blob" rg_minmax_filtered)
  sstrows=$(sumkey "$blob" num_sst_rows)
  # result row count + latency (warm)
  "${MYSQL[@]}" -e "SELECT count(*) FROM $tbl WHERE $where;" >/dev/null 2>&1
  local t0 t1
  t0=$(python3 -c 'import time;print(time.time())')
  resrows=$("${MYSQL[@]}" -e "SELECT count(*) FROM $tbl WHERE $where;" 2>/dev/null)
  t1=$(python3 -c 'import time;print(time.time())')
  ms=$(python3 -c "print(f'{($t1-$t0)*1000:.0f}')")
  printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s ms |\n' \
    "$label" "$itype" "$resrows" "$sstrows" "$rgt" "$rgb" "$rgi" "$rgm" "$ms"
}

echo "## G3.1 EXPLAIN ANALYZE VERBOSE prune snapshot"
echo
echo "Scale: traces 300k / observations 1.5M / scores 600k (project smoke-proj), compacted (strict_window 86400)."
echo "samples: trace=$TRACE user=$USER sess=$SESS sc_obs=$SC_OBS"
echo
echo "| column (filter) | index | result rows | sst_rows scanned | rg_total | rg_bloom_filtered | rg_inverted_filtered | rg_minmax_filtered | latency |"
echo "|---|---|---|---|---|---|---|---|---|"
# bloom skipping (equality)
row "observations.trace_id=trace" bloom observations "project_id='$PROJ' AND trace_id='$TRACE'"
row "traces.session_id=sess" bloom traces "project_id='$PROJ' AND session_id='$SESS'"
row "traces.user_id=user" bloom traces "project_id='$PROJ' AND user_id='$USER'"
row "scores.trace_id=trace" bloom scores "project_id='$PROJ' AND trace_id='$SC_TRACE'"
[ -n "$SC_OBS" ] && row "scores.observation_id=obs" bloom scores "project_id='$PROJ' AND observation_id='$SC_OBS'"
# inverted (low-cardinality, selective values)
row "observations.type=EVENT(6)" inverted observations "project_id='$PROJ' AND type='EVENT'"
row "observations.type=SPAN(40%)" inverted observations "project_id='$PROJ' AND type='SPAN'"
row "observations.level=WARNING(6)" inverted observations "project_id='$PROJ' AND level='WARNING'"
row "observations.level=ERROR(3.4%)" inverted observations "project_id='$PROJ' AND level='ERROR'"
row "observations.environment=production(8)" inverted observations "project_id='$PROJ' AND environment='production'"
row "scores.source=EVAL(4)" inverted scores "project_id='$PROJ' AND source='EVAL'"
row "scores.data_type=CATEGORICAL(6)" inverted scores "project_id='$PROJ' AND data_type='CATEGORICAL'"
row "traces.environment=production(8)" inverted traces "project_id='$PROJ' AND environment='production'"
# baseline: dominant value (index correctly NOT used)
row "observations.type=GENERATION(60%)" inverted observations "project_id='$PROJ' AND type='GENERATION'"
row "scores.data_type=NUMERIC(~100%)" inverted scores "project_id='$PROJ' AND data_type='NUMERIC'"
