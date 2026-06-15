/** @vitest-environment node */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";

import type { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import type * as SharedDb from "@langfuse/shared/src/db";

import handler from "@/src/pages/api/public/media/[mediaId]/download";
import { getLocalMediaDownloadUrl } from "@/src/features/media/server/localMediaStorage";

const { localPath, mediaFindUnique } = vi.hoisted(() => {
  const os = require("node:os");
  const nodePath = require("node:path");
  const { randomUUID } = require("node:crypto");
  return {
    localPath: nodePath.join(os.tmpdir(), `lf-media-dl-${randomUUID()}`),
    mediaFindUnique: vi.fn(),
  };
});

vi.mock("@/src/env.mjs", () => ({
  env: {
    LANGFUSE_MEDIA_STORAGE_BACKEND: "local",
    LANGFUSE_MEDIA_LOCAL_PATH: localPath,
    NEXTAUTH_SECRET: "unit-test-secret",
    SALT: "unit-test-salt",
    NEXTAUTH_URL: "http://localhost:3000",
  },
}));

vi.mock("@langfuse/shared/src/db", async () => ({
  ...(await vi.importActual<typeof SharedDb>("@langfuse/shared/src/db")),
  prisma: { media: { findUnique: mediaFindUnique } },
}));

const projectId = "project-1";
const mediaId = "media-1";
const bucketPath = "project-1/media-1.png";
const contentType = "image/png";
const body = "Hello, media!"; // 13 bytes
const filePath = path.join(localPath, bucketPath);

const tokenFor = () =>
  new URL(
    getLocalMediaDownloadUrl({
      projectId,
      mediaId,
      bucketPath,
      contentType,
      contentLength: body.length,
      ttlSeconds: 60,
    }),
  ).searchParams.get("token")!;

// node-mocks-http responses never emit "finish", so `pipeline(stream, res)`
// in the handler would hang. Back the response with a real Writable that
// captures chunks and completes, while exposing the NextApiResponse surface
// the handler uses.
class MockRes extends Writable {
  statusCode = 200;
  headersSent = false;
  private readonly headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];

  setHeader(key: string, value: string | number) {
    this.headers[key.toLowerCase()] = String(value);
  }
  getHeader(key: string) {
    return this.headers[key.toLowerCase()];
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  send(data?: unknown) {
    this.end(data === undefined ? undefined : String(data));
    return this;
  }
  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void,
  ) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  getData() {
    return Buffer.concat(this.chunks).toString();
  }
}

const runGet = async (
  query: Record<string, string | undefined>,
  headers: Record<string, string> = {},
) => {
  const { req } = createMocks<NextApiRequest, NextApiResponse>({
    method: "GET",
    query,
    headers,
  });
  const res = new MockRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
};

describe("GET /api/public/media/[mediaId]/download (local backend)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    mediaFindUnique.mockResolvedValue({
      id: mediaId,
      projectId,
      bucketPath,
      uploadHttpStatus: 200,
    });
  });

  afterAll(async () => {
    await rm(localPath, { recursive: true, force: true });
  });

  test("serves the full body with range headers", async () => {
    const res = await runGet({ mediaId, token: tokenFor() });

    expect(res.statusCode).toBe(200);
    expect(res.getHeader("Accept-Ranges")).toBe("bytes");
    expect(res.getHeader("Content-Type")).toBe(contentType);
    expect(res.getHeader("Content-Length")).toBe(String(body.length));
    expect(res.getData()).toBe(body);
  });

  test("serves a closed byte range as 206", async () => {
    const res = await runGet(
      { mediaId, token: tokenFor() },
      { range: "bytes=0-4" },
    );

    expect(res.statusCode).toBe(206);
    expect(res.getHeader("Content-Range")).toBe(`bytes 0-4/${body.length}`);
    expect(res.getHeader("Content-Length")).toBe("5");
    expect(res.getData()).toBe("Hello");
  });

  test("serves a suffix range as 206", async () => {
    const res = await runGet(
      { mediaId, token: tokenFor() },
      { range: "bytes=-5" },
    );

    expect(res.statusCode).toBe(206);
    expect(res.getHeader("Content-Range")).toBe(`bytes 8-12/${body.length}`);
    expect(res.getData()).toBe("edia!");
  });

  test("returns 416 for an unsatisfiable range", async () => {
    const res = await runGet(
      { mediaId, token: tokenFor() },
      { range: "bytes=100-" },
    );

    expect(res.statusCode).toBe(416);
    expect(res.getHeader("Content-Range")).toBe(`bytes */${body.length}`);
  });

  test("returns 404 when the media row is missing", async () => {
    mediaFindUnique.mockResolvedValue(null);
    const res = await runGet({ mediaId, token: tokenFor() });
    expect(res.statusCode).toBe(404);
  });

  test("returns 404 when the upload is not finished", async () => {
    mediaFindUnique.mockResolvedValue({
      id: mediaId,
      projectId,
      bucketPath,
      uploadHttpStatus: null,
    });
    const res = await runGet({ mediaId, token: tokenFor() });
    expect(res.statusCode).toBe(404);
  });

  test("returns 400 for a missing/invalid token", async () => {
    const res = await runGet({ mediaId, token: "not-a-valid-token" });
    expect(res.statusCode).toBe(400);
  });

  test("returns 405 for non-GET methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      query: { mediaId },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});
