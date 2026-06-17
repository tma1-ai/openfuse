export function useExperimentAccess() {
  // Experiments were gated behind the v4 beta, which is now removed.
  return {
    canAccessExperiments: false,
    canSeeExperimentsNav: false,
    isExperimentsBetaActive: false,
    isInitializing: false,
    isV4BetaEnabled: false,
  };
}
