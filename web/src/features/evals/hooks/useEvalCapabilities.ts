import { useSession } from "next-auth/react";
import { api } from "@/src/utils/api";
import { useIsCodeEvalEnabled } from "@/src/features/evals/hooks/useIsCodeEvalEnabled";

export interface EvalCapabilities {
  isNewCompatible: boolean;
  compatibilityCheckWasPerformed: boolean;
  allowLegacy: boolean;
  allowPropagationFilters: boolean;
  isLoading: boolean;
  hasLegacyEvals: boolean;
}

/**
 * Hook to determine which eval configuration features are available
 * @param projectId - The project ID to check
 * @param options - Optional configuration
 * @param options.isCodeEvalTemplate - When true and code evals are enabled, disables legacy eval options
 * @returns Capabilities object indicating which eval features are allowed
 */
export function useEvalCapabilities(
  projectId: string,
  options?: {
    isCodeEvalTemplate?: boolean;
  },
): EvalCapabilities {
  const { status: sessionStatus } = useSession();
  const isSessionLoading = sessionStatus === "loading";
  const { enabled: isCodeEvalEnabled } = useIsCodeEvalEnabled();
  const isCodeEvalConfig =
    isCodeEvalEnabled && (options?.isCodeEvalTemplate ?? false);

  // Get eval counts including legacy eval count
  const evalCounts = api.evals.counts.useQuery({ projectId });
  const hasLegacyEvals = (evalCounts.data?.legacyConfigCount ?? 0) > 0;

  return {
    // OTEL compatibility was only surfaced via the v4 events path.
    isNewCompatible: false,
    compatibilityCheckWasPerformed: false,
    // Legacy is the only experience now; allow it unless this is a code eval.
    allowLegacy: !isCodeEvalConfig,
    allowPropagationFilters: false,
    isLoading: evalCounts.isLoading || isSessionLoading,
    hasLegacyEvals,
  };
}
