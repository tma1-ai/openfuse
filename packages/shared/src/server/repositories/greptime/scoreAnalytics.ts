import { greptimeQuery } from "../../greptime/client";
import { greptimeTsParam, notDeleted } from "./queryHelpers";

/**
 * GreptimeDB port of the score-comparison analytics query builder (04-read-path.md, P7 Piece 5b).
 *
 * The ClickHouse original lived in `web/src/features/score-analytics/server/*`. This module owns the
 * SQL building *and* execution for both the preflight estimate and the comprehensive comparison
 * query; the web router (`scoreAnalyticsRouter`) keeps the sampling/threshold orchestration and the
 * 12-column result parsing unchanged.
 *
 * ClickHouse -> GreptimeDB translation notes (all probed against openfuse):
 *   - `FINAL` / `PREWHERE` dropped: the projection is already merged (merge_mode=last_non_null) and
 *     every read carries `is_deleted = false` (CH physically deleted; GreptimeDB tombstones).
 *   - `cityHash64(...) % 100 < pct` sampling -> `greptimeScoreSamplingExpression`, a deterministic,
 *     composite-key-stable, uniform md5-derived bucket (see that helper).
 *   - `ifNull` -> `coalesce`; `toString(value)` -> `arrow_cast(value, 'Utf8')`;
 *     `toUnixTimestamp(ts)` -> `to_unixtime(ts)`; `stddevPop` -> `stddev_pop`; `if(...)` -> `CASE`.
 *   - `toStartOf*` time bucketing -> `date_trunc` (the read pool is UTC-pinned; week truncates to
 *     Monday, matching CH `toStartOfWeek(_, 1)`).
 *   - `rankCorr` (Spearman) has no GreptimeDB equivalent. It is computed natively as
 *     `corr(rank1, rank2)` over an average-rank CTE (`spearman_ranked`) — statistically exact with
 *     tie correction. GreptimeDB is the source of truth, so a correct Spearman is the target rather
 *     than bug-for-bug CH `rankCorr` parity.
 *   - `CAST(x AS Nullable(T))` -> `CAST(x AS T)`; every UNION ALL column is cast explicitly so the
 *     branch types unify (DataFusion is stricter than ClickHouse here).
 *
 * `nBins` (validated 5..50) and `samplingPercent` (a computed integer) are interpolated as integer
 * literals; all user-controlled strings/timestamps are bound as named parameters.
 */

export type ScoreAnalyticsInterval = {
  count: number;
  unit: "second" | "minute" | "hour" | "day" | "month" | "year";
};

/**
 * Every numeric column is `CAST(... AS DOUBLE)` in the query, so mysql2 returns JS numbers (only
 * DECIMAL/BIGINT come back as strings — see rowContract); the two category columns are strings.
 */
export type ScoreComparisonResultRow = {
  result_type: string;
  col1: number | null;
  col2: number | null;
  col3: number | null;
  col4: number | null;
  col5: number | null;
  col6: number | null;
  col7: number | null;
  col8: number | null;
  col9: string | null;
  col10: string | null;
  col11: number | null;
  col12: number | null;
};

type ScoreSelector = { name: string; dataType: string; source: string };

/**
 * Exclusive object-type filter (a score is attached to exactly one of trace/observation/session/run).
 * Identical to the ClickHouse fragment — the GreptimeDB scores projection keeps the same reference
 * columns. Emitted as a WHERE fragment (leading `AND`).
 */
export const buildScoreObjectTypeFilter = (objectType: string): string => {
  if (objectType === "trace")
    return "AND trace_id IS NOT NULL AND observation_id IS NULL AND session_id IS NULL AND dataset_run_id IS NULL";
  if (objectType === "observation") return "AND observation_id IS NOT NULL";
  if (objectType === "session")
    return "AND session_id IS NOT NULL AND observation_id IS NULL AND trace_id IS NULL AND dataset_run_id IS NULL";
  if (objectType === "dataset_run")
    return "AND dataset_run_id IS NOT NULL AND trace_id IS NULL AND observation_id IS NULL AND session_id IS NULL";
  return "";
};

/** Composite key hashed for sampling — same shape ClickHouse fed `cityHash64`. */
const SAMPLING_COMPOSITE_KEY =
  "concat(coalesce(trace_id, ''), coalesce(observation_id, ''), coalesce(session_id, ''), coalesce(dataset_run_id, ''))";

/**
 * Deterministic hash-bucket sampling predicate, the GreptimeDB stand-in for ClickHouse
 * `cityHash64(composite) % 100 < pct`.
 *
 * `md5(composite)` -> 32-char hex; strip non-decimal nibbles, left-pad so it is never empty, take 15
 * leading digits (fits Int64), then `abs(mod(_, 100))`. Probed on openfuse to be:
 *   - composite-key-stable: identical composite keys land in the same bucket, so a score in `score1`
 *     and its pair in `score2` sample together (the property the matched-pair estimate relies on);
 *   - uniform: over 5000 keys the 100 buckets stayed within ~3σ of even (the earlier trailing-pad
 *     variant spiked bucket 0 — the leading pad fixes that).
 *
 * `samplingPercent` is a computed integer, interpolated directly.
 */
export const greptimeScoreSamplingExpression = (
  samplingPercent: number,
): string =>
  `abs(mod(arrow_cast(substr('0' || regexp_replace(md5(${SAMPLING_COMPOSITE_KEY}), '[^0-9]', '', 'g'), 1, 15), 'Int64'), 100)) < ${samplingPercent}`;

/**
 * Calendar time-bucket expression. Mirrors the ClickHouse builder's normalization: a 7-day interval
 * is an ISO week (Monday-aligned), every other interval collapses to its single calendar unit.
 */
const scoreTimeBucket = (
  field: string,
  interval: ScoreAnalyticsInterval,
): string => {
  if (interval.count === 7 && interval.unit === "day")
    return `date_trunc('week', ${field})`;
  return `date_trunc('${interval.unit}', ${field})`;
};

const buildScoreComparisonQuery = (params: {
  score1: ScoreSelector;
  score2: ScoreSelector;
  interval: ScoreAnalyticsInterval;
  nBins: number;
  objectType: string;
  shouldSample: boolean;
  samplingPercent: number;
  isIdenticalScores: boolean;
  isSingleScore: boolean;
  isNumeric: boolean;
  isCategoricalComparison: boolean;
}): string => {
  const {
    interval,
    nBins,
    objectType,
    shouldSample,
    samplingPercent,
    isIdenticalScores,
    isSingleScore,
    isNumeric,
    isCategoricalComparison,
  } = params;

  const objectTypeFilter = buildScoreObjectTypeFilter(objectType);
  const sampling = shouldSample
    ? `AND ${greptimeScoreSamplingExpression(samplingPercent)}`
    : "";
  const del = notDeleted();

  // String form of a (possibly numeric) value for categorical/confusion buckets.
  const catValue = (n: string) =>
    `coalesce(string_value${n}, arrow_cast(value${n}, 'Utf8'))`;

  // ---- distributions ----
  const numericDistribution = (
    cte: string,
    source: string,
    valueCol: string,
    minCol: string,
    maxCol: string,
  ) => `${cte} AS (
        SELECT
          floor((s.${valueCol} - b.${minCol}) /
                ((b.${maxCol} - b.${minCol} + 0.0001) / ${nBins})) AS bin_index,
          count(*) AS count
        FROM ${source} s
        CROSS JOIN bounds b
        GROUP BY floor((s.${valueCol} - b.${minCol}) /
                ((b.${maxCol} - b.${minCol} + 0.0001) / ${nBins}))
      )`;

  const categoricalDistribution = (
    cte: string,
    source: string,
    n: string,
  ) => `${cte} AS (
        SELECT
          (row_number() OVER (ORDER BY ${catValue(n)}) - 1) AS bin_index,
          count(*) AS count
        FROM ${source}
        WHERE string_value${n} IS NOT NULL OR value${n} IS NOT NULL
        GROUP BY ${catValue(n)}
      )`;

  const distribution1CTE = isNumeric
    ? numericDistribution(
        "distribution1",
        "score1_filtered",
        "value",
        "global_min",
        "global_max",
      )
    : categoricalDistribution("distribution1", "score1_filtered", "");
  const distribution2CTE = isNumeric
    ? numericDistribution(
        "distribution2",
        "score2_filtered",
        "value",
        "global_min",
        "global_max",
      )
    : categoricalDistribution("distribution2", "score2_filtered", "");
  const distribution1MatchedCTE = isNumeric
    ? numericDistribution(
        "distribution1_matched",
        "matched_scores",
        "value1",
        "global_min",
        "global_max",
      )
    : categoricalDistribution("distribution1_matched", "matched_scores", "1");
  const distribution2MatchedCTE = isNumeric
    ? numericDistribution(
        "distribution2_matched",
        "matched_scores",
        "value2",
        "global_min",
        "global_max",
      )
    : categoricalDistribution("distribution2_matched", "matched_scores", "2");
  const distribution1IndividualCTE = isNumeric
    ? numericDistribution(
        "distribution1_individual",
        "score1_filtered",
        "value",
        "min1",
        "max1",
      )
    : `distribution1_individual AS (SELECT bin_index, count FROM distribution1)`;
  const distribution2IndividualCTE = isNumeric
    ? numericDistribution(
        "distribution2_individual",
        "score2_filtered",
        "value",
        "min2",
        "max2",
      )
    : `distribution2_individual AS (SELECT bin_index, count FROM distribution2)`;

  // ---- time series (avg) ----
  const timeseriesCTE = isSingleScore
    ? `timeseries AS (
        SELECT
          ${scoreTimeBucket("timestamp", interval)} AS ts,
          avg(value) AS avg1,
          CAST(NULL AS DOUBLE) AS avg2,
          count(*) AS count
        FROM score1_filtered
        WHERE value IS NOT NULL
        GROUP BY ${scoreTimeBucket("timestamp", interval)}
      )`
    : `timeseries AS (
        SELECT
          COALESCE(s1.ts, s2.ts) AS ts,
          s1.avg1 AS avg1,
          s2.avg2 AS avg2,
          (COALESCE(s1.count1, 0) + COALESCE(s2.count2, 0)) AS count
        FROM (
          SELECT ${scoreTimeBucket("timestamp", interval)} AS ts, avg(value) AS avg1, count(*) AS count1
          FROM score1_filtered WHERE value IS NOT NULL
          GROUP BY ${scoreTimeBucket("timestamp", interval)}
        ) s1
        FULL OUTER JOIN (
          SELECT ${scoreTimeBucket("timestamp", interval)} AS ts, avg(value) AS avg2, count(*) AS count2
          FROM score2_filtered WHERE value IS NOT NULL
          GROUP BY ${scoreTimeBucket("timestamp", interval)}
        ) s2 ON s1.ts = s2.ts
      )`;

  const timeseriesMatchedCTE = isSingleScore
    ? `timeseries_matched AS (
        SELECT
          ${scoreTimeBucket("timestamp1", interval)} AS ts,
          avg(value1) AS avg1,
          CAST(NULL AS DOUBLE) AS avg2,
          count(*) AS count
        FROM matched_scores
        WHERE value1 IS NOT NULL
        GROUP BY ${scoreTimeBucket("timestamp1", interval)}
      )`
    : `timeseries_matched AS (
        SELECT
          ${scoreTimeBucket("timestamp1", interval)} AS ts,
          avg(value1) AS avg1,
          avg(value2) AS avg2,
          count(*) AS count
        FROM matched_scores
        GROUP BY ${scoreTimeBucket("timestamp1", interval)}
      )`;

  // ---- categorical time series (counts per category) ----
  const emptyCategoricalTs = (cte: string) => `${cte} AS (
        SELECT CAST(NULL AS TIMESTAMP) AS ts, CAST(NULL AS STRING) AS category, CAST(NULL AS DOUBLE) AS count
        WHERE 1 = 0
      )`;
  const categoricalTs = (
    cte: string,
    source: string,
    field: string,
    n: string,
  ) => `${cte} AS (
        SELECT
          ${scoreTimeBucket(field, interval)} AS ts,
          ${catValue(n)} AS category,
          count(*) AS count
        FROM ${source}
        WHERE string_value${n} IS NOT NULL OR value${n} IS NOT NULL
        GROUP BY ${scoreTimeBucket(field, interval)}, ${catValue(n)}
      )`;

  const timeseriesCategorical1CTE = categoricalTs(
    "timeseries_categorical1",
    "score1_filtered",
    "timestamp",
    "",
  );
  const timeseriesCategorical2CTE = isSingleScore
    ? emptyCategoricalTs("timeseries_categorical2")
    : categoricalTs(
        "timeseries_categorical2",
        "score2_filtered",
        "timestamp",
        "",
      );
  const timeseriesCategorical1MatchedCTE = categoricalTs(
    "timeseries_categorical1_matched",
    "matched_scores",
    "timestamp1",
    "1",
  );
  const timeseriesCategorical2MatchedCTE = isSingleScore
    ? emptyCategoricalTs("timeseries_categorical2_matched")
    : categoricalTs(
        "timeseries_categorical2_matched",
        "matched_scores",
        "timestamp1",
        "2",
      );

  // ---- filtering CTEs ----
  const score1Filtered = `score1_filtered AS (
        SELECT id, value, string_value,
          trace_id, observation_id, session_id, dataset_run_id AS run_id, timestamp
        FROM scores
        WHERE project_id = :projectId
          AND name = :score1Name
          AND source = :score1Source
          AND data_type = :dataType1
          AND timestamp >= :fromTimestamp
          AND timestamp <= :toTimestamp
          AND ${del}
          ${objectTypeFilter}
          ${sampling}
      )`;
  const score2Filtered = `score2_filtered AS (
        ${
          isIdenticalScores
            ? "SELECT * FROM score1_filtered"
            : `SELECT id, value, string_value,
          trace_id, observation_id, session_id, dataset_run_id AS run_id, timestamp
        FROM scores
        WHERE project_id = :projectId
          AND name = :score2Name
          AND source = :score2Source
          AND data_type = :dataType2
          AND timestamp >= :fromTimestamp
          AND timestamp <= :toTimestamp
          AND ${del}
          ${objectTypeFilter}
          ${sampling}`
        }
      )`;

  const matchedJoin = isIdenticalScores
    ? "s1.id = s2.id"
    : `coalesce(s1.trace_id, '') = coalesce(s2.trace_id, '')
          AND coalesce(s1.observation_id, '') = coalesce(s2.observation_id, '')
          AND coalesce(s1.session_id, '') = coalesce(s2.session_id, '')
          AND coalesce(s1.run_id, '') = coalesce(s2.run_id, '')`;
  const matchedScores = `matched_scores AS (
        SELECT
          s1.value AS value1,
          s1.string_value AS string_value1,
          ${isIdenticalScores ? "s1.value" : "s2.value"} AS value2,
          ${isIdenticalScores ? "s1.string_value" : "s2.string_value"} AS string_value2,
          s1.timestamp AS timestamp1
        FROM score1_filtered s1
        INNER JOIN ${isIdenticalScores ? "score1_filtered" : "score2_filtered"} s2
          ON ${matchedJoin}
        LIMIT 1000000
      )`;

  // Spearman: avg-rank ranks fed to corr. Only meaningful for numeric, non-identical comparisons.
  const spearmanRankedCTE =
    isNumeric && !isIdenticalScores
      ? `,
      spearman_ranked AS (
        SELECT
          rank() OVER (ORDER BY value1) + (count(*) OVER (PARTITION BY value1) - 1) / 2.0 AS r1,
          rank() OVER (ORDER BY value2) + (count(*) OVER (PARTITION BY value2) - 1) / 2.0 AS r2
        FROM matched_scores
        WHERE value1 IS NOT NULL AND value2 IS NOT NULL
      )`
      : "";

  const statsNumeric = `
          (SELECT avg(value) FROM score1_filtered) AS mean1,
          (SELECT avg(value) FROM score2_filtered) AS mean2,
          (SELECT stddev_pop(value) FROM score1_filtered) AS std1,
          (SELECT stddev_pop(value) FROM score2_filtered) AS std2,
          (SELECT avg(abs(value1 - value2)) FROM matched_scores) AS mae,
          (SELECT sqrt(avg(pow(value1 - value2, 2))) FROM matched_scores) AS rmse,
          ${
            isIdenticalScores
              ? "CAST(NULL AS DOUBLE)"
              : `CASE WHEN (SELECT is_safe FROM correlation_check)
            THEN (SELECT corr(value1, value2) FROM matched_scores) ELSE NULL END`
          } AS pearson_correlation,
          ${
            isIdenticalScores
              ? "CAST(NULL AS DOUBLE)"
              : `CASE WHEN (SELECT is_safe FROM correlation_check)
            THEN (SELECT corr(r1, r2) FROM spearman_ranked) ELSE NULL END`
          } AS spearman_correlation`;
  const statsCategorical = `
          CAST(NULL AS DOUBLE) AS mean1,
          CAST(NULL AS DOUBLE) AS mean2,
          CAST(NULL AS DOUBLE) AS std1,
          CAST(NULL AS DOUBLE) AS std2,
          CAST(NULL AS DOUBLE) AS mae,
          CAST(NULL AS DOUBLE) AS rmse,
          CAST(NULL AS DOUBLE) AS pearson_correlation,
          CAST(NULL AS DOUBLE) AS spearman_correlation`;

  const categoricalCTEs = isCategoricalComparison
    ? `,
      score1_with_score2 AS (
        SELECT
          coalesce(s1.string_value, arrow_cast(s1.value, 'Utf8')) AS score1_category,
          coalesce(s2.string_value, arrow_cast(s2.value, 'Utf8')) AS score2_category
        FROM score1_filtered s1
        LEFT JOIN score2_filtered s2
          ON coalesce(s1.trace_id, '') = coalesce(s2.trace_id, '')
          AND coalesce(s1.observation_id, '') = coalesce(s2.observation_id, '')
          AND coalesce(s1.session_id, '') = coalesce(s2.session_id, '')
          AND coalesce(s1.run_id, '') = coalesce(s2.run_id, '')
        LIMIT 1000000
      ),
      stacked_distribution AS (
        SELECT
          score1_category,
          coalesce(score2_category, '__unmatched__') AS score2_stack,
          count(*) AS count
        FROM score1_with_score2
        WHERE score1_category IS NOT NULL
        GROUP BY score1_category, coalesce(score2_category, '__unmatched__')
      ),
      score2_categories AS (
        SELECT DISTINCT coalesce(string_value, arrow_cast(value, 'Utf8')) AS category
        FROM score2_filtered
        WHERE string_value IS NOT NULL OR value IS NOT NULL
      ),
      stacked_distribution_matched AS (
        SELECT
          ${catValue("1")} AS score1_category,
          ${catValue("2")} AS score2_stack,
          count(*) AS count
        FROM matched_scores
        WHERE (string_value1 IS NOT NULL OR value1 IS NOT NULL)
          AND (string_value2 IS NOT NULL OR value2 IS NOT NULL)
        GROUP BY ${catValue("1")}, ${catValue("2")}
      )`
    : "";

  const categoricalUnion = isCategoricalComparison
    ? `
    UNION ALL
    SELECT 'stacked' AS result_type,
      CAST(count AS DOUBLE) AS col1, CAST(NULL AS DOUBLE) AS col2, CAST(NULL AS DOUBLE) AS col3,
      CAST(NULL AS DOUBLE) AS col4, CAST(NULL AS DOUBLE) AS col5, CAST(NULL AS DOUBLE) AS col6,
      CAST(NULL AS DOUBLE) AS col7, CAST(NULL AS DOUBLE) AS col8,
      score1_category AS col9, score2_stack AS col10,
      CAST(NULL AS DOUBLE) AS col11, CAST(NULL AS DOUBLE) AS col12
    FROM stacked_distribution
    UNION ALL
    SELECT 'score2_categories' AS result_type,
      CAST(NULL AS DOUBLE) AS col1, CAST(NULL AS DOUBLE) AS col2, CAST(NULL AS DOUBLE) AS col3,
      CAST(NULL AS DOUBLE) AS col4, CAST(NULL AS DOUBLE) AS col5, CAST(NULL AS DOUBLE) AS col6,
      CAST(NULL AS DOUBLE) AS col7, CAST(NULL AS DOUBLE) AS col8,
      category AS col9, CAST(NULL AS STRING) AS col10,
      CAST(NULL AS DOUBLE) AS col11, CAST(NULL AS DOUBLE) AS col12
    FROM score2_categories
    UNION ALL
    SELECT 'stacked_matched' AS result_type,
      CAST(count AS DOUBLE) AS col1, CAST(NULL AS DOUBLE) AS col2, CAST(NULL AS DOUBLE) AS col3,
      CAST(NULL AS DOUBLE) AS col4, CAST(NULL AS DOUBLE) AS col5, CAST(NULL AS DOUBLE) AS col6,
      CAST(NULL AS DOUBLE) AS col7, CAST(NULL AS DOUBLE) AS col8,
      score1_category AS col9, score2_stack AS col10,
      CAST(NULL AS DOUBLE) AS col11, CAST(NULL AS DOUBLE) AS col12
    FROM stacked_distribution_matched`
    : "";

  const distributionUnion = (resultType: string, source: string) => `
    UNION ALL
    SELECT '${resultType}' AS result_type,
      CAST(bin_index AS DOUBLE) AS col1, CAST(count AS DOUBLE) AS col2, CAST(NULL AS DOUBLE) AS col3,
      CAST(NULL AS DOUBLE) AS col4, CAST(NULL AS DOUBLE) AS col5, CAST(NULL AS DOUBLE) AS col6,
      CAST(NULL AS DOUBLE) AS col7, CAST(NULL AS DOUBLE) AS col8,
      CAST(NULL AS STRING) AS col9, CAST(NULL AS STRING) AS col10,
      CAST(NULL AS DOUBLE) AS col11, CAST(NULL AS DOUBLE) AS col12
    FROM ${source}`;

  const avgTimeseriesUnion = (resultType: string, source: string) => `
    UNION ALL
    SELECT '${resultType}' AS result_type,
      arrow_cast(to_unixtime(ts), 'Float64') AS col1, CAST(avg1 AS DOUBLE) AS col2, CAST(avg2 AS DOUBLE) AS col3,
      CAST(count AS DOUBLE) AS col4, CAST(NULL AS DOUBLE) AS col5, CAST(NULL AS DOUBLE) AS col6,
      CAST(NULL AS DOUBLE) AS col7, CAST(NULL AS DOUBLE) AS col8,
      CAST(NULL AS STRING) AS col9, CAST(NULL AS STRING) AS col10,
      CAST(NULL AS DOUBLE) AS col11, CAST(NULL AS DOUBLE) AS col12
    FROM ${source}`;

  const categoricalTsUnion = (resultType: string, source: string) => `
    UNION ALL
    SELECT '${resultType}' AS result_type,
      arrow_cast(to_unixtime(ts), 'Float64') AS col1, CAST(NULL AS DOUBLE) AS col2, CAST(NULL AS DOUBLE) AS col3,
      CAST(count AS DOUBLE) AS col4, CAST(NULL AS DOUBLE) AS col5, CAST(NULL AS DOUBLE) AS col6,
      CAST(NULL AS DOUBLE) AS col7, CAST(NULL AS DOUBLE) AS col8,
      category AS col9, CAST(NULL AS STRING) AS col10,
      CAST(NULL AS DOUBLE) AS col11, CAST(NULL AS DOUBLE) AS col12
    FROM ${source}`;

  return `
    WITH
      ${score1Filtered},
      ${score2Filtered},
      ${matchedScores},
      matched_count AS (SELECT count(*) AS cnt FROM matched_scores),
      bounds AS (
        SELECT
          least((SELECT min(value) FROM score1_filtered), (SELECT min(value) FROM score2_filtered)) AS global_min,
          greatest((SELECT max(value) FROM score1_filtered), (SELECT max(value) FROM score2_filtered)) AS global_max,
          (SELECT min(value) FROM score1_filtered) AS min1,
          (SELECT max(value) FROM score1_filtered) AS max1,
          (SELECT min(value) FROM score2_filtered) AS min2,
          (SELECT max(value) FROM score2_filtered) AS max2
        FROM (SELECT 1) one
      ),
      heatmap AS (
        SELECT
          floor((m.value1 - b.min1) / ((b.max1 - b.min1 + 0.0001) / ${nBins})) AS bin_x,
          floor((m.value2 - b.min2) / ((b.max2 - b.min2 + 0.0001) / ${nBins})) AS bin_y,
          count(*) AS count,
          b.global_min, b.global_max, b.min1, b.max1, b.min2, b.max2
        FROM matched_scores m
        CROSS JOIN bounds b
        GROUP BY
          floor((m.value1 - b.min1) / ((b.max1 - b.min1 + 0.0001) / ${nBins})),
          floor((m.value2 - b.min2) / ((b.max2 - b.min2 + 0.0001) / ${nBins})),
          b.global_min, b.global_max, b.min1, b.max1, b.min2, b.max2
      ),
      confusion AS (
        SELECT
          ${catValue("1")} AS row_category,
          ${catValue("2")} AS col_category,
          count(*) AS count
        FROM matched_scores
        GROUP BY ${catValue("1")}, ${catValue("2")}
      )${categoricalCTEs},
      correlation_check AS (
        SELECT count(*) >= 2 AND stddev_pop(value1) > 0 AND stddev_pop(value2) > 0 AS is_safe
        FROM matched_scores
      )${spearmanRankedCTE},
      stats AS (
        SELECT
          (SELECT count(*) FROM matched_scores) AS matched_count,
          ${isNumeric ? statsNumeric : statsCategorical}
        FROM (SELECT 1) one
      ),
      ${timeseriesCTE},
      ${distribution1CTE},
      ${distribution2CTE},
      ${distribution1MatchedCTE},
      ${distribution2MatchedCTE},
      ${distribution1IndividualCTE},
      ${distribution2IndividualCTE},
      ${timeseriesMatchedCTE},
      ${timeseriesCategorical1CTE},
      ${timeseriesCategorical2CTE},
      ${timeseriesCategorical1MatchedCTE},
      ${timeseriesCategorical2MatchedCTE}

    SELECT 'counts' AS result_type,
      CAST((SELECT count(*) FROM score1_filtered) AS DOUBLE) AS col1,
      CAST((SELECT count(*) FROM score2_filtered) AS DOUBLE) AS col2,
      CAST((SELECT cnt FROM matched_count) AS DOUBLE) AS col3,
      CAST(NULL AS DOUBLE) AS col4, CAST(NULL AS DOUBLE) AS col5, CAST(NULL AS DOUBLE) AS col6,
      CAST(NULL AS DOUBLE) AS col7, CAST(NULL AS DOUBLE) AS col8,
      CAST(NULL AS STRING) AS col9, CAST(NULL AS STRING) AS col10,
      CAST(NULL AS DOUBLE) AS col11, CAST(NULL AS DOUBLE) AS col12
    FROM (SELECT 1) one

    UNION ALL
    SELECT 'heatmap' AS result_type,
      CAST(bin_x AS DOUBLE) AS col1, CAST(bin_y AS DOUBLE) AS col2, CAST(count AS DOUBLE) AS col3,
      CAST(min1 AS DOUBLE) AS col4, CAST(max1 AS DOUBLE) AS col5, CAST(min2 AS DOUBLE) AS col6,
      CAST(max2 AS DOUBLE) AS col7, CAST(NULL AS DOUBLE) AS col8,
      CAST(NULL AS STRING) AS col9, CAST(NULL AS STRING) AS col10,
      CAST(global_min AS DOUBLE) AS col11, CAST(global_max AS DOUBLE) AS col12
    FROM heatmap

    UNION ALL
    SELECT 'confusion' AS result_type,
      CAST(count AS DOUBLE) AS col1, CAST(NULL AS DOUBLE) AS col2, CAST(NULL AS DOUBLE) AS col3,
      CAST(NULL AS DOUBLE) AS col4, CAST(NULL AS DOUBLE) AS col5, CAST(NULL AS DOUBLE) AS col6,
      CAST(NULL AS DOUBLE) AS col7, CAST(NULL AS DOUBLE) AS col8,
      row_category AS col9, col_category AS col10,
      CAST(NULL AS DOUBLE) AS col11, CAST(NULL AS DOUBLE) AS col12
    FROM confusion

    UNION ALL
    SELECT 'stats' AS result_type,
      CAST(matched_count AS DOUBLE) AS col1, CAST(mean1 AS DOUBLE) AS col2, CAST(mean2 AS DOUBLE) AS col3,
      CAST(std1 AS DOUBLE) AS col4, CAST(std2 AS DOUBLE) AS col5, CAST(pearson_correlation AS DOUBLE) AS col6,
      CAST(mae AS DOUBLE) AS col7, CAST(rmse AS DOUBLE) AS col8,
      CAST(NULL AS STRING) AS col9, CAST(NULL AS STRING) AS col10,
      CAST(NULL AS DOUBLE) AS col11, CAST(spearman_correlation AS DOUBLE) AS col12
    FROM stats
    ${avgTimeseriesUnion("timeseries", "timeseries")}
    ${distributionUnion("distribution1", "distribution1")}
    ${distributionUnion("distribution2", "distribution2")}${categoricalUnion}
    ${distributionUnion("distribution1_matched", "distribution1_matched")}
    ${distributionUnion("distribution2_matched", "distribution2_matched")}
    ${distributionUnion("distribution1_individual", "distribution1_individual")}
    ${distributionUnion("distribution2_individual", "distribution2_individual")}
    ${avgTimeseriesUnion("timeseries_matched", "timeseries_matched")}
    ${categoricalTsUnion("timeseries_categorical1", "timeseries_categorical1")}
    ${categoricalTsUnion("timeseries_categorical2", "timeseries_categorical2")}
    ${categoricalTsUnion("timeseries_categorical1_matched", "timeseries_categorical1_matched")}
    ${categoricalTsUnion("timeseries_categorical2_matched", "timeseries_categorical2_matched")}
  `;
};

/**
 * Comprehensive score-comparison analytics. Returns the raw `result_type` + `col1..col12` rows; the
 * web router parses them into the structured response (12-column contract unchanged from ClickHouse).
 */
export const getScoreComparisonAnalyticsGreptime = async (params: {
  projectId: string;
  score1: ScoreSelector;
  score2: ScoreSelector;
  fromTimestamp: Date;
  toTimestamp: Date;
  interval: ScoreAnalyticsInterval;
  nBins: number;
  objectType: string;
  shouldSample: boolean;
  samplingPercent: number;
  isIdenticalScores: boolean;
  isSingleScore: boolean;
  isNumeric: boolean;
  isCategoricalComparison: boolean;
}): Promise<ScoreComparisonResultRow[]> => {
  const query = buildScoreComparisonQuery(params);
  return greptimeQuery<ScoreComparisonResultRow>({
    query,
    params: {
      projectId: params.projectId,
      score1Name: params.score1.name,
      score1Source: params.score1.source,
      dataType1: params.score1.dataType,
      score2Name: params.score2.name,
      score2Source: params.score2.source,
      dataType2: params.score2.dataType,
      fromTimestamp: greptimeTsParam(params.fromTimestamp),
      toTimestamp: greptimeTsParam(params.toTimestamp),
    },
  });
};

/**
 * Preflight estimate (1% hash sample, scaled x100). Mirrors the ClickHouse `buildEstimateQuery`:
 * cheap counts used by the router to decide FINAL/sampling and to surface an ETA.
 */
export const estimateScoreComparisonGreptime = async (params: {
  projectId: string;
  score1Name: string;
  score1Source: string;
  score1DataType: string;
  score2Name: string;
  score2Source: string;
  score2DataType: string;
  fromTimestamp: Date;
  toTimestamp: Date;
  objectType: string;
}): Promise<{
  score1Count: number;
  score2Count: number;
  estimatedMatchedCount: number;
}> => {
  const objectTypeFilter = buildScoreObjectTypeFilter(params.objectType);
  const sampling = greptimeScoreSamplingExpression(1);
  const del = notDeleted();

  const query = `
    WITH
      score1_sample AS (
        SELECT trace_id, observation_id, session_id, dataset_run_id
        FROM scores
        WHERE project_id = :projectId
          AND name = :score1Name
          AND source = :score1Source
          AND data_type = :score1DataType
          AND timestamp >= :fromTimestamp
          AND timestamp <= :toTimestamp
          AND ${del}
          AND ${sampling}
          ${objectTypeFilter}
      ),
      score2_sample AS (
        SELECT trace_id, observation_id, session_id, dataset_run_id
        FROM scores
        WHERE project_id = :projectId
          AND name = :score2Name
          AND source = :score2Source
          AND data_type = :score2DataType
          AND timestamp >= :fromTimestamp
          AND timestamp <= :toTimestamp
          AND ${del}
          AND ${sampling}
          ${objectTypeFilter}
      )
    SELECT
      (SELECT count(*) FROM score1_sample) * 100 AS score1_count,
      (SELECT count(*) FROM score2_sample) * 100 AS score2_count,
      (
        SELECT count(*) * 100
        FROM score1_sample s1
        INNER JOIN score2_sample s2
          ON coalesce(s1.trace_id, '') = coalesce(s2.trace_id, '')
          AND coalesce(s1.observation_id, '') = coalesce(s2.observation_id, '')
          AND coalesce(s1.session_id, '') = coalesce(s2.session_id, '')
          AND coalesce(s1.dataset_run_id, '') = coalesce(s2.dataset_run_id, '')
      ) AS estimated_matched_count
    FROM (SELECT 1) one
  `;

  const rows = await greptimeQuery<{
    score1_count: number | string | null;
    score2_count: number | string | null;
    estimated_matched_count: number | string | null;
  }>({
    query,
    params: {
      projectId: params.projectId,
      score1Name: params.score1Name,
      score1Source: params.score1Source,
      score1DataType: params.score1DataType,
      score2Name: params.score2Name,
      score2Source: params.score2Source,
      score2DataType: params.score2DataType,
      fromTimestamp: greptimeTsParam(params.fromTimestamp),
      toTimestamp: greptimeTsParam(params.toTimestamp),
    },
  });

  const row = rows[0];
  return {
    score1Count: Number(row?.score1_count ?? 0),
    score2Count: Number(row?.score2_count ?? 0),
    estimatedMatchedCount: Number(row?.estimated_matched_count ?? 0),
  };
};
