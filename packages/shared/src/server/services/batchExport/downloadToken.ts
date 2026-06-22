import crypto from "node:crypto";

import { env } from "../../../env";
import { InvalidRequestError } from "../../../errors";

/**
 * Signed download tokens for local-backend batch exports.
 *
 * The S3 batch-export flow hands the user a time-limited presigned URL. Local
 * file storage has no presigned-URL equivalent, so we mint an HMAC-signed token
 * that the web download route verifies before streaming the file. The token is
 * the security boundary equivalent to a presigned URL: unauthenticated-but-
 * cryptographically-signed and time-limited, scoped to a single export. The
 * download route additionally re-validates the `batchExport` row (project scope,
 * status, expiry), so the effective check is strictly stronger than a presigned
 * URL.
 *
 * Minted by the worker (handleBatchExportJob), verified by the web route, both
 * via the shared signing secret so the resolution is identical on both sides.
 */

type BatchExportDownloadTokenPayload = {
  projectId: string;
  batchExportId: string;
  // Relative path of the export file under the local batch-export base
  // directory; the download route resolves and streams it.
  fileName: string;
  contentType: string;
  expiresAt: number;
};

const base64UrlEncode = (value: string): string =>
  Buffer.from(value).toString("base64url");

const base64UrlDecode = (value: string): string =>
  Buffer.from(value, "base64url").toString("utf8");

const getSigningSecret = (): string => {
  const secret = env.NEXTAUTH_SECRET ?? env.SALT;
  if (!secret) {
    throw new Error(
      "NEXTAUTH_SECRET or SALT must be set to sign batch export download tokens",
    );
  }
  return secret;
};

const sign = (payload: string): string =>
  crypto
    .createHmac("sha256", getSigningSecret())
    .update(payload)
    .digest("base64url");

const getPublicBaseUrl = (): string =>
  (env.NEXTAUTH_URL ?? "http://localhost:3000").replace(/\/api\/auth\/?$/, "");

export const createBatchExportDownloadToken = (
  payload: Omit<BatchExportDownloadTokenPayload, "expiresAt">,
  ttlSeconds: number,
): string => {
  const encodedPayload = base64UrlEncode(
    JSON.stringify({
      ...payload,
      expiresAt: Date.now() + ttlSeconds * 1000,
    } satisfies BatchExportDownloadTokenPayload),
  );

  return `${encodedPayload}.${sign(encodedPayload)}`;
};

export const verifyBatchExportDownloadToken = (
  token: string | string[] | undefined,
  expected: { batchExportId: string },
): BatchExportDownloadTokenPayload => {
  if (!token || Array.isArray(token)) {
    throw new InvalidRequestError("Missing batch export download token");
  }

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    throw new InvalidRequestError("Invalid batch export download token");
  }

  const expectedSignature = sign(encodedPayload);
  if (signature.length !== expectedSignature.length) {
    throw new InvalidRequestError(
      "Invalid batch export download token signature",
    );
  }
  if (
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    )
  ) {
    throw new InvalidRequestError(
      "Invalid batch export download token signature",
    );
  }

  let payload: BatchExportDownloadTokenPayload;
  try {
    payload = JSON.parse(
      base64UrlDecode(encodedPayload),
    ) as BatchExportDownloadTokenPayload;
  } catch {
    throw new InvalidRequestError(
      "Invalid batch export download token payload",
    );
  }

  if (payload.expiresAt < Date.now()) {
    throw new InvalidRequestError("Batch export download token expired");
  }
  if (payload.batchExportId !== expected.batchExportId) {
    throw new InvalidRequestError(
      "Batch export download token does not match request",
    );
  }

  return payload;
};

export const getBatchExportLocalDownloadUrl = (params: {
  projectId: string;
  batchExportId: string;
  fileName: string;
  contentType: string;
  ttlSeconds: number;
}): string => {
  const token = createBatchExportDownloadToken(
    {
      projectId: params.projectId,
      batchExportId: params.batchExportId,
      fileName: params.fileName,
      contentType: params.contentType,
    },
    params.ttlSeconds,
  );

  return `${getPublicBaseUrl()}/api/public/batch-exports/${encodeURIComponent(
    params.batchExportId,
  )}/download?token=${encodeURIComponent(token)}`;
};
