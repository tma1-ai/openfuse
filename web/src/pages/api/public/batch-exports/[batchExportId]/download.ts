import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { NextApiRequest, NextApiResponse } from "next";

import { env } from "@/src/env.mjs";
import { BatchExportStatus } from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import {
  logger,
  resolveLocalStoragePath,
  verifyBatchExportDownloadToken,
} from "@langfuse/shared/src/server";

/**
 * Authenticated download route for local-backend batch exports.
 *
 * Replaces the S3 presigned URL when LANGFUSE_BATCH_EXPORT_STORAGE_BACKEND is
 * "local". The signed token (minted by the worker) is the integrity boundary;
 * we additionally re-validate the batchExport row (project scope, COMPLETED
 * status, not expired) so access is strictly stronger than a presigned URL.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).end();
    return;
  }

  if (env.LANGFUSE_BATCH_EXPORT_STORAGE_BACKEND !== "local") {
    res.status(404).end();
    return;
  }

  const batchExportId = String(req.query.batchExportId ?? "");
  try {
    const token = verifyBatchExportDownloadToken(req.query.token, {
      batchExportId,
    });

    const batchExport = await prisma.batchExport.findFirst({
      where: {
        id: token.batchExportId,
        projectId: token.projectId,
      },
    });

    if (
      !batchExport ||
      batchExport.status !== BatchExportStatus.COMPLETED ||
      (batchExport.expiresAt !== null && batchExport.expiresAt < new Date())
    ) {
      res.status(404).end();
      return;
    }

    if (!env.LANGFUSE_BATCH_EXPORT_LOCAL_PATH) {
      logger.error(
        "LANGFUSE_BATCH_EXPORT_LOCAL_PATH is not set but the local batch export backend is selected",
      );
      res.status(500).end();
      return;
    }

    const filePath = resolveLocalStoragePath(
      env.LANGFUSE_BATCH_EXPORT_LOCAL_PATH,
      token.fileName,
    );

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

    const downloadName = path.basename(token.fileName);
    // RFC 5987/6266: give an ASCII-only fallback (control chars, quotes, and
    // non-ASCII stripped so the header cannot be broken or injected) plus a
    // UTF-8 `filename*` carrying the real name. Mirrors the trace download route.
    const asciiFallback =
      downloadName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") ||
      "batch-export";
    res.setHeader("Content-Type", token.contentType);
    res.setHeader("Content-Length", String(size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    );

    await pipeline(createReadStream(filePath), res);
  } catch (error) {
    logger.warn("Batch export download failed", { error, batchExportId });
    if (!res.headersSent) {
      res
        .status(400)
        .send(error instanceof Error ? error.message : "Bad request");
    }
  }
}
