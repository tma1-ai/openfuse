/** @vitest-environment node */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import type { NextApiRequest, NextApiResponse } from "next";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import type * as SharedDb from "@langfuse/shared/src/db";

import handler from "@/src/pages/api/public/media/[mediaId]/upload";
import { getLocalMediaUploadUrl } from "@/src/features/media/server/localMediaStorage";

const { localPath, mediaFindUnique, mediaUpdate } = vi.hoisted(() => {
  const os = require("node:os");
  const nodePath = require("node:path");
  const { randomUUID } = require("node:crypto");
  return {
    localPath: nodePath.join(os.tmpdir(), `lf-media-up-${randomUUID()}`),
    mediaFindUnique: vi.fn(),
    mediaUpdate: vi.fn(),
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
  prisma: { media: { findUnique: mediaFindUnique, update: mediaUpdate } },
}));

const projectId = "project-1";
const mediaId = "media-1";
const bucketPath = "project-1/media-1.png";
const contentType = "image/png";
const body = "Hello, media!";
const sha256 = createHash("sha256").update(body).digest("base64");
const filePath = path.join(localPath, bucketPath);

const tokenFor = (overrides: { sha256Hash?: string } = {}) =>
  new URL(
    getLocalMediaUploadUrl({
      projectId,
      mediaId,
      bucketPath,
      contentType,
      contentLength: body.length,
      sha256Hash: overrides.sha256Hash ?? sha256,
      ttlSeconds: 60,
    }),
  ).searchParams.get("token")!;

// A minimal NextApiResponse capturing status without buffering anything; the
// upload handler never streams to the response.
class MockRes {
  statusCode = 200;
  headersSent = false;
  private readonly headers: Record<string, string> = {};
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
  send() {
    this.headersSent = true;
    return this;
  }
  end() {
    this.headersSent = true;
    return this;
  }
}

const makeReq = (opts: {
  method?: string;
  token: string;
  data?: string;
  contentLength?: number;
  contentType?: string;
}): NextApiRequest => {
  const req = Readable.from(
    opts.data !== undefined ? [Buffer.from(opts.data)] : [],
  ) as unknown as NextApiRequest & { [k: string]: unknown };
  req.method = opts.method ?? "PUT";
  req.query = { mediaId, token: opts.token };
  req.headers = {
    "content-length": String(opts.contentLength ?? body.length),
    "content-type": opts.contentType ?? contentType,
  };
  return req;
};

const run = async (req: NextApiRequest) => {
  const res = new MockRes();
  await handler(req, res as unknown as NextApiResponse);
  return res;
};

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe("PUT /api/public/media/[mediaId]/upload (local backend)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await rm(localPath, { recursive: true, force: true });
    await mkdir(localPath, { recursive: true });
    mediaFindUnique.mockResolvedValue({
      id: mediaId,
      projectId,
      bucketName: "local",
      bucketPath,
    });
    mediaUpdate.mockResolvedValue({});
  });

  afterAll(async () => {
    await rm(localPath, { recursive: true, force: true });
  });

  test("stores the file and marks the upload succeeded", async () => {
    const res = await run(makeReq({ token: tokenFor(), data: body }));

    expect(res.statusCode).toBe(200);
    expect(await readFile(filePath, "utf8")).toBe(body);
    expect(mediaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadHttpStatus: 200 }),
      }),
    );
    // No leftover temp part files in the directory.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path.dirname(filePath));
    expect(entries).toEqual(["media-1.png"]);
  });

  test("rejects a Content-Length that does not match the token", async () => {
    const res = await run(
      makeReq({
        token: tokenFor(),
        data: body,
        contentLength: body.length + 1,
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(await exists(filePath)).toBe(false);
  });

  test("rejects a Content-Type that does not match the token", async () => {
    const res = await run(
      makeReq({ token: tokenFor(), data: body, contentType: "image/jpeg" }),
    );
    expect(res.statusCode).toBe(400);
    expect(await exists(filePath)).toBe(false);
  });

  test("rejects a body whose hash does not match and cleans up", async () => {
    // Same length as `body` so the Content-Length check passes and the
    // handler reaches the SHA-256 verification.
    const tampered = "Goodbye media";
    expect(tampered.length).toBe(body.length);
    const res = await run(makeReq({ token: tokenFor(), data: tampered }));

    expect(res.statusCode).toBe(400);
    expect(await exists(filePath)).toBe(false);
    expect(mediaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadHttpStatus: 400 }),
      }),
    );
  });

  test("returns 404 when the media row is missing", async () => {
    mediaFindUnique.mockResolvedValue(null);
    const res = await run(makeReq({ token: tokenFor(), data: body }));
    expect(res.statusCode).toBe(404);
  });

  test("returns 405 for non-PUT methods", async () => {
    const res = await run(makeReq({ method: "GET", token: tokenFor() }));
    expect(res.statusCode).toBe(405);
  });
});
