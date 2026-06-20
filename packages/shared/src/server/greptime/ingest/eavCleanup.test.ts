import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ greptimeQuery: vi.fn() }));
vi.mock("../client", () => ({ greptimeQuery: mocks.greptimeQuery }));

import { deleteEavRowsForEntities } from "./eavCleanup";

describe("deleteEavRowsForEntities", () => {
  beforeEach(() => {
    mocks.greptimeQuery.mockReset();
    mocks.greptimeQuery.mockResolvedValue([]);
  });

  it("emits one project-scoped DELETE with an expanded named IN-list", async () => {
    await deleteEavRowsForEntities(
      "observations_tool_definitions",
      new Map([["p1", new Set(["e1", "e2"])]]),
    );

    expect(mocks.greptimeQuery).toHaveBeenCalledTimes(1);
    const { query, params } = mocks.greptimeQuery.mock.calls[0][0];
    expect(query).toContain("DELETE FROM `observations_tool_definitions`");
    expect(query).toContain("`project_id` = :p");
    expect(query).toContain("`entity_id` IN (:e0, :e1)");
    expect(params).toEqual({ p: "p1", e0: "e1", e1: "e2" });
  });

  it("issues a separate DELETE per project (entity ids are project-scoped)", async () => {
    await deleteEavRowsForEntities(
      "traces_metadata",
      new Map([
        ["p1", new Set(["a"])],
        ["p2", new Set(["b"])],
      ]),
    );
    expect(mocks.greptimeQuery).toHaveBeenCalledTimes(2);
    expect(mocks.greptimeQuery.mock.calls.map((c) => c[0].params)).toEqual([
      { p: "p1", e0: "a" },
      { p: "p2", e0: "b" },
    ]);
  });

  it("chunks large entity sets (<= 500 ids per DELETE)", async () => {
    const ids = new Set(Array.from({ length: 1200 }, (_, i) => `e${i}`));
    await deleteEavRowsForEntities("scores_metadata", new Map([["p", ids]]));
    // 1200 -> 500 + 500 + 200 = 3 statements
    expect(mocks.greptimeQuery).toHaveBeenCalledTimes(3);
  });

  it("is a no-op for an empty entity map", async () => {
    await deleteEavRowsForEntities("traces_tags", new Map());
    expect(mocks.greptimeQuery).not.toHaveBeenCalled();
  });
});
