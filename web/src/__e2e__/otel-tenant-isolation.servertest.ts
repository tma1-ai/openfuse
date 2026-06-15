import {
  createOrgProjectAndApiKey,
  greptimeQuery,
} from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import waitForExpect from "wait-for-expect";
import { randomBytes } from "crypto";
import { afterAll } from "vitest";

describe("OTEL ingestion tenant isolation", () => {
  const createdOrgIds: string[] = [];

  afterAll(async () => {
    if (createdOrgIds.length === 0) return;
    await prisma.organization.deleteMany({
      where: { id: { in: createdOrgIds } },
    });
  });

  it("span posted with project A's key lands only in project A's observations", async () => {
    const projectA = await createOrgProjectAndApiKey();
    const projectB = await createOrgProjectAndApiKey();
    createdOrgIds.push(projectA.orgId, projectB.orgId);

    const traceId = randomBytes(16);
    const spanId = randomBytes(8);
    const spanIdHex = spanId.toString("hex");

    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: {
                name: "langfuse-sdk",
                version: "1.0.0",
                attributes: [],
              },
              spans: [
                {
                  traceId,
                  spanId,
                  name: "tenant-isolation-test-span",
                  kind: 1,
                  startTimeUnixNano: {
                    low: 466848096,
                    high: 406528574,
                    unsigned: true,
                  },
                  endTimeUnixNano: {
                    low: 467248096,
                    high: 406528574,
                    unsigned: true,
                  },
                  attributes: [],
                  status: {},
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await fetch(
      "http://localhost:3000/api/public/otel/v1/traces",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: projectA.auth,
        },
        body: JSON.stringify(payload),
      },
    );
    expect(response.status).toBe(200);

    await waitForExpect(
      async () => {
        const rowsA = await greptimeQuery<{ count: string | number }>({
          // merge-on-write collapses retry-induced duplicate inserts to one
          // logical row per (project_id, id), so a strict toBe(1) cannot be
          // inflated by the OtelIngestionQueue retries (attempts: 6).
          query: `SELECT count(*) as count FROM observations
            WHERE project_id = :projectId AND id = :spanId AND is_deleted = false`,
          params: { projectId: projectA.projectId, spanId: spanIdHex },
          readOnly: true,
        });
        expect(Number(rowsA[0]?.count)).toBe(1);

        const rowsB = await greptimeQuery<{ count: string | number }>({
          // merge-on-write collapses retry-induced duplicate inserts to one
          // logical row per (project_id, id), so a strict toBe(1) cannot be
          // inflated by the OtelIngestionQueue retries (attempts: 6).
          query: `SELECT count(*) as count FROM observations
            WHERE project_id = :projectId AND id = :spanId AND is_deleted = false`,
          params: { projectId: projectB.projectId, spanId: spanIdHex },
          readOnly: true,
        });
        expect(Number(rowsB[0]?.count)).toBe(0);
      },
      40_000,
      1_000,
    );
  }, 60_000);
});
