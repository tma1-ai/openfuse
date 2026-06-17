import { z } from "zod";
import {
  EvalTargetObject,
  observationVariableMapping,
  type EvalTargetObject as EvalTargetObjectType,
  type FilterCondition,
} from "@langfuse/shared";
import type { PrismaClient } from "@prisma/client";

export type CodeEvalJobConfigErrorCode =
  | "invalid_target"
  | "invalid_request"
  | "resource_not_found"
  | "preflight_failed";

export class CodeEvalJobConfigError extends Error {
  constructor(
    message: string,
    readonly code: CodeEvalJobConfigErrorCode = "preflight_failed",
  ) {
    super(message);
    this.name = "CodeEvalJobConfigError";
    Object.setPrototypeOf(this, CodeEvalJobConfigError.prototype);
  }
}

export async function assertCodeEvalJobConfigCanRun(params: {
  prisma: PrismaClient;
  orgId: string;
  projectId: string;
  evalTemplateId: string;
  target: EvalTargetObjectType;
  mapping: unknown;
  scoreName: string;
  filter: FilterCondition[] | null;
}): Promise<void> {
  if (
    params.target !== EvalTargetObject.EVENT &&
    params.target !== EvalTargetObject.EXPERIMENT
  ) {
    throw new CodeEvalJobConfigError(
      "Code evaluators can only run on observations or experiments.",
      "invalid_target",
    );
  }

  z.array(observationVariableMapping).parse(params.mapping);
}
