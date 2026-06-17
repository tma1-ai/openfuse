import React from "react";
import { useRouter } from "next/router";
import SessionsTable from "@/src/components/table/use-cases/sessions";
import Page from "@/src/components/layouts/page";
import { SessionsOnboarding } from "@/src/components/onboarding/SessionsOnboarding";
import { api } from "@/src/utils/api";

export default function Sessions() {
  const router = useRouter();
  const projectId = router.query.projectId as string;

  const { data: hasSessions, isLoading: isLoadingSessions } =
    api.sessions.hasAny.useQuery(
      { projectId },
      {
        enabled: !!projectId,
        trpc: {
          context: {
            skipBatch: true,
          },
        },
        refetchInterval: 10_000,
      },
    );

  const showOnboarding = !isLoadingSessions && !hasSessions;

  return (
    <Page
      headerProps={{
        title: "Sessions",
        help: {
          description: (
            <>
              A session is a collection of related traces, such as a
              conversation or thread. To begin, add a sessionId to the trace.
              See{" "}
              <a
                href="https://langfuse.com/docs/observability/features/sessions"
                target="_blank"
                rel="noopener noreferrer"
                className="decoration-primary/30 hover:decoration-primary underline"
                onClick={(e) => e.stopPropagation()}
              >
                docs
              </a>{" "}
              to learn more.
            </>
          ),
          href: "https://langfuse.com/docs/observability/features/sessions",
        },
      }}
      scrollable={showOnboarding}
    >
      {/* Show onboarding screen if user has no sessions */}
      {showOnboarding ? (
        <SessionsOnboarding />
      ) : (
        <SessionsTable projectId={projectId} />
      )}
    </Page>
  );
}
