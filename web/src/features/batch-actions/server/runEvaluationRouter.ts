import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { TRPCError } from "@trpc/server";
import { CreateObservationBatchEvaluationActionSchema } from "../validation";

export const runEvaluationRouter = createTRPCRouter({
  create: protectedProjectProcedure
    .input(CreateObservationBatchEvaluationActionSchema)
    .mutation(async () => {
      // The events-backed batch evaluation surface was removed and is no longer
      // supported.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Events-backed batch evaluation is no longer supported and has been removed.",
      });
    }),
});
