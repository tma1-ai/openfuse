import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import type { NextApiRequest, NextApiResponse } from "next";

import { env } from "@/src/env.mjs";
import { resolveByteRange } from "@/src/features/media/server/byteRange";
import { verifyLocalMediaToken } from "@/src/features/media/server/localMediaStorage";
import { prisma } from "@langfuse/shared/src/db";
import { logger, resolveLocalStoragePath } from "@langfuse/shared/src/server";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).end();
    return;
  }

  if (env.LANGFUSE_MEDIA_STORAGE_BACKEND !== "local") {
    res.status(404).end();
    return;
  }

  const mediaId = String(req.query.mediaId ?? "");
  try {
    const token = verifyLocalMediaToken(req.query.token, {
      action: "download",
      mediaId,
    });

    const media = await prisma.media.findUnique({
      where: {
        projectId_id: {
          projectId: token.projectId,
          id: token.mediaId,
        },
      },
    });
    if (
      !media ||
      media.bucketPath !== token.bucketPath ||
      !(media.uploadHttpStatus === 200 || media.uploadHttpStatus === 201)
    ) {
      res.status(404).end();
      return;
    }

    const filePath = resolveLocalStoragePath(
      env.LANGFUSE_MEDIA_LOCAL_PATH!,
      token.bucketPath,
    );

    // Use the actual on-disk size as the source of truth for range math and
    // Content-Length so a stale token length can never truncate or overrun.
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).end();
        return;
      }
      throw error;
    }

    res.setHeader("Content-Type", token.contentType);
    // Advertise range support so audio/video elements can seek; without this
    // some browsers (notably Safari/WebKit) refuse to play media at all.
    res.setHeader("Accept-Ranges", "bytes");

    const resolution = resolveByteRange(req.headers.range, size);

    if (resolution.kind === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${size}`);
      res.status(416).end();
      return;
    }

    if (resolution.kind === "range") {
      const { start, end } = resolution.range;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      await pipeline(createReadStream(filePath, { start, end }), res);
      return;
    }

    res.setHeader("Content-Length", String(size));
    await pipeline(createReadStream(filePath), res);
  } catch (error) {
    logger.warn("Local media download failed", { error, mediaId });
    if (!res.headersSent) {
      res
        .status(400)
        .send(error instanceof Error ? error.message : "Bad request");
    }
  }
}
