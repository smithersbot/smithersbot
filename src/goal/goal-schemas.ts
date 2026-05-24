import { z } from "zod";

const NonEmptyStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Expected non-empty string",
});

export const GoalWorkerOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("complete"),
    summary: z.string(),
  }),
  z.object({
    status: z.literal("blocked"),
    question: z.string(),
  }),
  z.object({
    status: z.literal("ralph"),
    approachTried: NonEmptyStringSchema,
    specificErrors: NonEmptyStringSchema,
    keyInsight: NonEmptyStringSchema,
    suggestedApproach: NonEmptyStringSchema,
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string(),
    whatTried: z.string(),
    errorType: z.string(),
    suggestedNext: z.string(),
    needsRevert: z.boolean(),
  }),
]);

const PlanBuildGateInputSchema = z.object({
  commands: z.array(z.string()),
  runBetweenSteps: z.boolean(),
  // Inert: post-execution LLM diff review was removed. Kept optional so old
  // serialized plans / planner output that still include it keep parsing.
  postExecutionReview: z.boolean().optional(),
});

const PlanStepInputSchema = z.object({
  id: z.union([z.string().min(1), z.number()]),
  description: z.string().min(1),
  shortSummary: z.string().optional(),
  successCriteria: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  dependsOn: z.array(z.union([z.string(), z.number()])).optional(),
  durationMinutes: z.number().optional(),
  backend: z.string().min(1),
  requiresNetwork: z.boolean().optional(),
});

export const PlanInputSchema = z.object({
  goal: z.string().min(1),
  workingDir: z.string().min(1),
  steps: z.array(PlanStepInputSchema).min(1),
  summary: z.string().optional(),
  shortSummary: z.string().optional(),
  buildGate: PlanBuildGateInputSchema.optional(),
});
