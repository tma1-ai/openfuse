import { describe, it, expect, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  env: {
    NEXTAUTH_SECRET: "test-signing-secret" as string | undefined,
    SALT: undefined as string | undefined,
    NEXTAUTH_URL: "http://localhost:3000" as string | undefined,
  },
}));
vi.mock("../../../env", () => envMock);

import {
  createBatchExportDownloadToken,
  verifyBatchExportDownloadToken,
  getBatchExportLocalDownloadUrl,
} from "./downloadToken";

const basePayload = {
  projectId: "proj_1",
  batchExportId: "be_1",
  fileName: "1700000000000-lf-traces-export-proj_1.csv",
  contentType: "text/csv",
};

describe("batch export download token", () => {
  it("round-trips a valid token and returns the payload", () => {
    const token = createBatchExportDownloadToken(basePayload, 3600);
    const payload = verifyBatchExportDownloadToken(token, {
      batchExportId: "be_1",
    });
    expect(payload).toMatchObject(basePayload);
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects a tampered payload (signature mismatch)", () => {
    const token = createBatchExportDownloadToken(basePayload, 3600);
    const [, signature] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({
        ...basePayload,
        projectId: "proj_evil",
        expiresAt: Date.now() + 3600_000,
      }),
    ).toString("base64url");
    expect(() =>
      verifyBatchExportDownloadToken(`${tampered}.${signature}`, {
        batchExportId: "be_1",
      }),
    ).toThrow(/signature/);
  });

  it("rejects a token signed with a different secret", () => {
    const token = createBatchExportDownloadToken(basePayload, 3600);
    envMock.env.NEXTAUTH_SECRET = "rotated-secret";
    try {
      expect(() =>
        verifyBatchExportDownloadToken(token, { batchExportId: "be_1" }),
      ).toThrow(/signature/);
    } finally {
      envMock.env.NEXTAUTH_SECRET = "test-signing-secret";
    }
  });

  it("rejects an expired token", () => {
    const token = createBatchExportDownloadToken(basePayload, -1);
    expect(() =>
      verifyBatchExportDownloadToken(token, { batchExportId: "be_1" }),
    ).toThrow(/expired/);
  });

  it("rejects a token whose batchExportId does not match the request", () => {
    const token = createBatchExportDownloadToken(basePayload, 3600);
    expect(() =>
      verifyBatchExportDownloadToken(token, { batchExportId: "be_other" }),
    ).toThrow(/does not match/);
  });

  it("rejects a missing or malformed token", () => {
    expect(() =>
      verifyBatchExportDownloadToken(undefined, { batchExportId: "be_1" }),
    ).toThrow(/Missing/);
    expect(() =>
      verifyBatchExportDownloadToken("no-dot-here", { batchExportId: "be_1" }),
    ).toThrow(/Invalid/);
  });

  it("falls back to SALT when NEXTAUTH_SECRET is unset", () => {
    envMock.env.NEXTAUTH_SECRET = undefined;
    envMock.env.SALT = "salt-secret";
    try {
      const token = createBatchExportDownloadToken(basePayload, 3600);
      expect(
        verifyBatchExportDownloadToken(token, { batchExportId: "be_1" }),
      ).toMatchObject(basePayload);
    } finally {
      envMock.env.NEXTAUTH_SECRET = "test-signing-secret";
      envMock.env.SALT = undefined;
    }
  });

  it("builds a download URL pointing at the web download route", () => {
    const url = getBatchExportLocalDownloadUrl({
      ...basePayload,
      ttlSeconds: 3600,
    });
    expect(url).toMatch(
      /^http:\/\/localhost:3000\/api\/public\/batch-exports\/be_1\/download\?token=/,
    );
    const token = decodeURIComponent(url.split("token=")[1]);
    expect(
      verifyBatchExportDownloadToken(token, { batchExportId: "be_1" }),
    ).toMatchObject(basePayload);
  });
});
