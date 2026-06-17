/**
 * This API endpoint checks if a custom SSO provider is configured for a given domain.
 *
 * Database-backed multi-tenant SSO is an enterprise feature that is not part of
 * this OSS build, so no per-domain provider is ever configured and this endpoint
 * always returns a 404. The route is kept because the sign-in/sign-up pages probe
 * it during the auth flow and treat 404 as "no enforced SSO".
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const requestSchema = z.object({
  domain: z.string().min(1),
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST")
    return res.status(405).json({ message: "Method not allowed" });

  const validBody = requestSchema.safeParse(req.body);
  if (!validBody.success) {
    return res.status(400).json({ message: "Invalid request body" });
  }

  return res.status(404).json({ message: "No SSO provider configured" });
}
