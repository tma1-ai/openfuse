import { ScenarioContext } from "./types";

/** Escapes LIKE-special characters so id prefixes match literally. */
export const escapeLike = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/[%_]/g, (match) => `\\${match}`);

export const traceLink = (
  ctx: ScenarioContext,
  traceId: string,
  timestampMs: number,
): string =>
  `${ctx.baseUrl}/project/${ctx.projectId}/traces/${encodeURIComponent(traceId)}?timestamp=${encodeURIComponent(new Date(timestampMs).toISOString())}`;

export const sessionLink = (ctx: ScenarioContext, sessionId: string): string =>
  `${ctx.baseUrl}/project/${ctx.projectId}/sessions/${encodeURIComponent(sessionId)}`;

export const tracesListLink = (ctx: ScenarioContext): string =>
  `${ctx.baseUrl}/project/${ctx.projectId}/traces`;
