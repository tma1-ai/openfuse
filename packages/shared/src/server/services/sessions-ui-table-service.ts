import { OrderByState } from "../../interfaces/orderBy";
import { FilterState } from "../../types";
import {
  getSessionsTableCountGreptime,
  getSessionsTableGreptime,
  getSessionsWithMetricsGreptime,
  type SessionDataReturnType,
  type SessionWithMetricsReturnType,
} from "../repositories/greptime/sessionsUiTable";

/**
 * Sessions UI table service (04-read-path.md, P2). The legacy ClickHouse 5-CTE rollup is replaced by
 * the GreptimeDB read path in `repositories/greptime/sessionsUiTable.ts`; these public functions
 * delegate there with unchanged signatures/return shapes.
 */

export type { SessionDataReturnType, SessionWithMetricsReturnType };

export const getSessionsTableCount = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}): Promise<number> => {
  return getSessionsTableCountGreptime(props);
};

export const getSessionsTable = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}): Promise<SessionDataReturnType[]> => {
  return getSessionsTableGreptime(props);
};

export const getSessionsWithMetrics = async (props: {
  projectId: string;
  filter: FilterState;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}): Promise<SessionWithMetricsReturnType[]> => {
  return getSessionsWithMetricsGreptime(props);
};
