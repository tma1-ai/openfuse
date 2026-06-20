import { greptimeQuery } from "../client";
import { quoteIdent } from "../schemaUtils";

/**
 * Write-path EAV consistency: delete an entity's existing rows in one EAV derived-index table before
 * its current set is re-written, so a key/tag/tool that dropped out of an updated entity does not
 * linger and keep matching `EXISTS` filters / breakdown joins (the GreptimeDB analogue of ClickHouse
 * reading the whole `Map` column off the latest ReplacingMergeTree row — see
 * `EAV_TABLES_FOR_PROJECTION`). Driven by the projection entity, NOT by the new EAV rows: an entity
 * whose set shrank to empty emits no EAV rows at all, yet its stale rows must still be cleared.
 *
 * Batched: one `DELETE ... WHERE project_id = ? AND entity_id IN (...)` per (project, chunk), so a
 * bulk backfill page is a handful of deletes, not one per entity. Idempotent and safe to re-run.
 *
 * The map is `projectId -> set of entityIds`; entity ids are only unique within a project, so the
 * delete must always pair both.
 */

// Keep IN-lists well under any wire/parse limit; a backfill page can carry thousands of entities.
const ENTITY_ID_CHUNK = 500;

export type DeleteEavRowsFn = (
  eavTable: string,
  entitiesByProject: ReadonlyMap<string, ReadonlySet<string>>,
) => Promise<void>;

export const deleteEavRowsForEntities: DeleteEavRowsFn = async (
  eavTable,
  entitiesByProject,
) => {
  for (const [projectId, entityIds] of entitiesByProject) {
    const ids = [...entityIds];
    for (let offset = 0; offset < ids.length; offset += ENTITY_ID_CHUNK) {
      const chunk = ids.slice(offset, offset + ENTITY_ID_CHUNK);
      // mysql2 does not splice a named array into a single placeholder, so expand one param per id.
      const params: Record<string, unknown> = { p: projectId };
      const placeholders = chunk.map((id, i) => {
        const name = `e${i}`;
        params[name] = id;
        return `:${name}`;
      });
      await greptimeQuery({
        query:
          `DELETE FROM ${quoteIdent(eavTable)} ` +
          `WHERE ${quoteIdent("project_id")} = :p ` +
          `AND ${quoteIdent("entity_id")} IN (${placeholders.join(", ")})`,
        params,
      });
    }
  }
};
