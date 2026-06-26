import { type Plan } from "@langfuse/shared";
import { type CloudConfigSchema } from "@langfuse/shared";

/**
 * Get the plan of the organization based on the cloud configuration. Used to add this plan to the organization object in JWT via NextAuth.
 */
export function getOrganizationPlanServerSide(
  cloudConfig?: CloudConfigSchema,
): Plan {
  if (process.env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION) {
    // in dev, grant team plan to all organizations
    // if (process.env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION === "DEV") {
    //   return "cloud:team";
    // }
    if (cloudConfig) {
      // manual plan override
      if (cloudConfig.plan) {
        switch (cloudConfig.plan) {
          case "Hobby":
            return "cloud:hobby";
          case "Core":
            return "cloud:core";
          case "Pro":
            return "cloud:pro";
          case "Team":
            return "cloud:team";
          case "Enterprise":
            return "cloud:enterprise";
          default:
            const exhaustiveCheck: never = cloudConfig.plan;
            throw new Error(`Unhandled plan case: ${exhaustiveCheck}`);
        }
      }
    }
    return "cloud:hobby";
  }

  return getSelfHostedInstancePlanServerSide();
}

// Openfuse is fully MIT-licensed: every feature ships unlocked, with no
// commercial license key or entitlement gate. Self-hosted instances always run
// at the highest tier.
export function getSelfHostedInstancePlanServerSide(): Plan {
  return "self-hosted:enterprise";
}
