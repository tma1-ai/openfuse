import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  greptimeQuery: vi.fn(),
}));

vi.mock("./client", () => ({
  greptimeQuery: mocks.greptimeQuery,
  getGreptimeIngestClient: () => ({ write: vi.fn() }),
}));

import { listRawEventEntities } from "./rawEvents";

/** Collapse whitespace so assertions are independent of SQL indentation. */
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("listRawEventEntities (D2 keyset enumeration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.greptimeQuery.mockResolvedValue([]);
  });

  it("first page (no cursor) filters by project only and binds just the project id", async () => {
    await listRawEventEntities({ projectId: "project-1", limit: 100 });

    const arg = mocks.greptimeQuery.mock.calls[0]?.[0];
    expect(arg.params).toEqual(["project-1"]);
    expect(arg.readOnly).toBe(true);
    const sql = normalize(arg.query);
    expect(sql).toContain("SELECT DISTINCT `entity_type`, `entity_id`");
    expect(sql).toContain("WHERE `project_id` = ?");
    // No keyset predicate on the first page.
    expect(sql).not.toContain("OR (");
    expect(sql).toContain("ORDER BY `entity_type` ASC, `entity_id` ASC");
    expect(sql).toContain("LIMIT 100");
  });

  it("next page expands the composite keyset predicate and binds the cursor in order", async () => {
    await listRawEventEntities({
      projectId: "project-1",
      limit: 50,
      cursor: { entityType: "score", entityId: "score-9" },
    });

    const arg = mocks.greptimeQuery.mock.calls[0]?.[0];
    // (entity_type, entity_id) > (cursor) written out: type strictly greater, OR same type and id greater.
    expect(normalize(arg.query)).toContain(
      "WHERE `project_id` = ? AND (`entity_type` > ? OR (`entity_type` = ? AND `entity_id` > ?))",
    );
    expect(arg.params).toEqual(["project-1", "score", "score", "score-9"]);
  });

  it("floors a fractional limit and clamps to at least 1", async () => {
    await listRawEventEntities({ projectId: "project-1", limit: 10.9 });
    expect(normalize(mocks.greptimeQuery.mock.calls[0]?.[0].query)).toContain(
      "LIMIT 10",
    );

    await listRawEventEntities({ projectId: "project-1", limit: 0 });
    expect(normalize(mocks.greptimeQuery.mock.calls[1]?.[0].query)).toContain(
      "LIMIT 1",
    );
  });

  it("renders a finite LIMIT for a non-finite limit instead of `LIMIT NaN`", async () => {
    await listRawEventEntities({ projectId: "project-1", limit: NaN });
    await listRawEventEntities({ projectId: "project-1", limit: Infinity });
    for (const call of mocks.greptimeQuery.mock.calls) {
      expect(normalize(call[0].query)).toContain("LIMIT 1");
    }
  });
});
