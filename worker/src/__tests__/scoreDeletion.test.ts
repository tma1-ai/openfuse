import { expect, describe, it } from "vitest";
import {
  createOrgProjectAndApiKey,
  createTraceScore,
  createScoresGreptime,
  getScoresByIds,
} from "@langfuse/shared/src/server";
import { processClickhouseScoreDelete } from "../features/scores/processClickhouseScoreDelete";

describe("score deletion", () => {
  it("should delete all scores from Clickhouse", async () => {
    // Setup
    const { projectId } = await createOrgProjectAndApiKey();

    const score = createTraceScore({ project_id: projectId });
    await createScoresGreptime([score]);

    // When
    await processClickhouseScoreDelete(projectId, [score.id]);

    // Then
    const scores = await getScoresByIds(projectId, [score.id]);
    expect(scores).toHaveLength(0);
  });
});
