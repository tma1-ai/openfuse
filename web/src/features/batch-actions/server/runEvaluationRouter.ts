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
      // The events table is no longer supported; this action is unavailable.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Events table is not enabled for this instance.",
      });
    }),
});
