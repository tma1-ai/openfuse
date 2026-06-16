import { type QueryType, type ViewVersion } from "../types";
import { executeGreptimeQuery } from "./greptimeQueryExecutor";

/**
 * Dashboard widget query entry point. Hard-swapped to the GreptimeDB engine
 * (04-read-path.md, P3): both v1 and v2 widget queries collapse onto the merged
 * GreptimeDB projection via `executeGreptimeQuery`. `version` and
 * `enableSingleLevelOptimization` are retained for call-site compatibility and
 * ignored (GreptimeDB collapses the versions and two-levels only when a relation
 * measure requires it).
 */
export async function executeQuery(
  projectId: string,
  query: QueryType,
  _version: ViewVersion = "v1",
  _enableSingleLevelOptimization: boolean = false,
): Promise<Array<Record<string, unknown>>> {
  return executeGreptimeQuery(projectId, query);
}
