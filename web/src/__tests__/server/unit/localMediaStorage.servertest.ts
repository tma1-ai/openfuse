import { describe, expect, test } from "vitest";

import {
  getLocalMediaDownloadUrl,
  getLocalMediaUploadUrl,
  verifyLocalMediaToken,
} from "@/src/features/media/server/localMediaStorage";

const tokenFromUrl = (url: string): string =>
  new URL(url).searchParams.get("token")!;

describe("local media signed URLs", () => {
  test("creates upload and download tokens scoped to action and media id", () => {
    const uploadUrl = getLocalMediaUploadUrl({
      projectId: "project-1",
      mediaId: "media-1",
      bucketPath: "project-1/media-1.png",
      contentType: "image/png",
      contentLength: 11,
      sha256Hash: "hash",
      ttlSeconds: 60,
    });

    const uploadToken = verifyLocalMediaToken(tokenFromUrl(uploadUrl), {
      action: "upload",
      mediaId: "media-1",
    });
    expect(uploadToken).toMatchObject({
      action: "upload",
      projectId: "project-1",
      mediaId: "media-1",
      bucketPath: "project-1/media-1.png",
      contentType: "image/png",
      contentLength: 11,
      sha256Hash: "hash",
    });

    expect(() =>
      verifyLocalMediaToken(tokenFromUrl(uploadUrl), {
        action: "download",
        mediaId: "media-1",
      }),
    ).toThrow("Local media token does not match request");

    const downloadUrl = getLocalMediaDownloadUrl({
      projectId: "project-1",
      mediaId: "media-1",
      bucketPath: "project-1/media-1.png",
      contentType: "image/png",
      contentLength: 11,
      ttlSeconds: 60,
    });

    expect(() =>
      verifyLocalMediaToken(tokenFromUrl(downloadUrl), {
        action: "download",
        mediaId: "media-2",
      }),
    ).toThrow("Local media token does not match request");
  });

  test("rejects an expired token", () => {
    const uploadUrl = getLocalMediaUploadUrl({
      projectId: "project-1",
      mediaId: "media-1",
      bucketPath: "project-1/media-1.png",
      contentType: "image/png",
      contentLength: 11,
      sha256Hash: "hash",
      ttlSeconds: -10,
    });

    expect(() =>
      verifyLocalMediaToken(tokenFromUrl(uploadUrl), {
        action: "upload",
        mediaId: "media-1",
      }),
    ).toThrow("Local media token expired");
  });

  test("rejects a tampered signature", () => {
    const uploadUrl = getLocalMediaUploadUrl({
      projectId: "project-1",
      mediaId: "media-1",
      bucketPath: "project-1/media-1.png",
      contentType: "image/png",
      contentLength: 11,
      sha256Hash: "hash",
      ttlSeconds: 60,
    });

    const token = tokenFromUrl(uploadUrl);
    const [payload, signature] = token.split(".");
    // Flip the last signature character to a different base64url symbol.
    const lastChar = signature.slice(-1);
    const tampered = `${payload}.${signature.slice(0, -1)}${lastChar === "A" ? "B" : "A"}`;

    expect(() =>
      verifyLocalMediaToken(tampered, { action: "upload", mediaId: "media-1" }),
    ).toThrow("Invalid local media token signature");
  });

  test("rejects a tampered payload", () => {
    const uploadUrl = getLocalMediaUploadUrl({
      projectId: "project-1",
      mediaId: "media-1",
      bucketPath: "project-1/media-1.png",
      contentType: "image/png",
      contentLength: 11,
      sha256Hash: "hash",
      ttlSeconds: 60,
    });

    const token = tokenFromUrl(uploadUrl);
    const [, signature] = token.split(".");
    // Re-sign nothing: swap in a different payload but keep the old signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({
        action: "upload",
        projectId: "project-1",
        mediaId: "media-1",
        bucketPath: "project-1/evil.png",
        contentType: "image/png",
        contentLength: 11,
        sha256Hash: "hash",
        expiresAt: Date.now() + 60_000,
      }),
    ).toString("base64url");

    expect(() =>
      verifyLocalMediaToken(`${forgedPayload}.${signature}`, {
        action: "upload",
        mediaId: "media-1",
      }),
    ).toThrow("Invalid local media token signature");
  });
});
