import type { NextApiRequest, NextApiResponse } from "next";
import * as z from "zod/v4";

import { getServerAuthSession } from "@/src/server/auth";
import { sendAdminAccessWebhook } from "@/src/server/adminAccessWebhook";
import { prisma } from "@langfuse/shared/src/db";
import { query as customQuery, viewVersions } from "@langfuse/shared/query";

const inputSchema = z.object({
  projectId: z.string(),
  query: customQuery,
  version: viewVersions.optional().default("v1"),
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).end();
    return;
  }

  const session = await getServerAuthSession({ req, res });
  if (!session?.user) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid input", errors: parsed.error });
    return;
  }

  const { projectId } = parsed.data;

  // Verify user is a member of this project (mirrors enforceUserIsAuthedAndProjectMember)
  const sessionProject = session.user.organizations
    .flatMap((org) =>
      org.projects.map((project) => ({ ...project, organization: org })),
    )
    .find((project) => project.id === projectId);

  if (!sessionProject) {
    if (session.user.admin === true) {
      const dbProject = await prisma.project.findFirst({
        select: { orgId: true },
        where: { id: projectId, deletedAt: null },
      });
      if (!dbProject) {
        res.status(404).json({ message: "Project not found" });
        return;
      }
      await sendAdminAccessWebhook({
        email: session.user.email,
        projectId,
        orgId: dbProject.orgId,
      });
    } else {
      res.status(403).json({ message: "Not a member of this project" });
      return;
    }
  } else if (session.user.admin === true) {
    await sendAdminAccessWebhook({
      email: session.user.email,
      projectId,
      orgId: sessionProject.organization.id,
    });
  }

  // Streaming dashboard queries were only ever served for the v4 beta, which is
  // no longer available. The endpoint stays mounted but rejects until streaming
  // ships for the GA dashboards.
  res.status(400).json({
    message: "Streaming is only supported for v4-enabled dashboard queries",
  });
  return;
}
