import { VERSION } from "@/src/constants/VERSION";
import { env } from "@/src/env.mjs";
import {
  createTRPCRouter,
  protectedProjectProcedure,
  publicProcedure,
} from "@/src/server/api/trpc";
import { logger, compareVersions } from "@langfuse/shared/src/server";
import { z } from "zod";

// GitHub Releases API shape for the fork's latest non-pre-release release.
const GithubLatestReleaseRes = z.object({
  tag_name: z.string(),
  html_url: z.url(),
});

export const publicRouter = createTRPCRouter({
  tracingSearchConfig: protectedProjectProcedure
    .input(z.object({ projectId: z.string() }))
    .query(() => ({
      legacyTracingIoSearchEnabled:
        env.LANGFUSE_DISABLE_LEGACY_TRACING_IO_SEARCH !== "true",
    })),
  checkUpdate: publicProcedure.query(async () => {
    // Skip update check on Langfuse Cloud
    if (env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION) return null;

    let body;
    try {
      const response = await fetch(
        "https://api.github.com/repos/tma1-ai/openfuse/releases/latest",
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "openfuse-update-check",
          },
        },
      );
      // 404 until a stable (non-pre-release) Openfuse release exists; while only
      // pre-releases are published there is nothing to surface.
      if (!response.ok) return null;
      body = await response.json();
    } catch (error) {
      logger.error("[trpc.public.checkUpdate] failed to fetch latest release", {
        error,
      });
      return null;
    }

    const release = GithubLatestReleaseRes.safeParse(body);
    if (!release.success) {
      logger.error(
        "[trpc.public.checkUpdate] release API response does not match schema",
        { error: release.error },
      );
      return null;
    }

    let updateType: "major" | "minor" | "patch" | null;
    try {
      updateType = compareVersions(VERSION, release.data.tag_name);
    } catch {
      // Non-semver tag (e.g. a named or date-based tag); nothing to compare.
      return null;
    }

    return {
      updateType,
      currentVersion: VERSION,
      latestRelease: release.data.tag_name,
      url: release.data.html_url,
    };
  }),
});
