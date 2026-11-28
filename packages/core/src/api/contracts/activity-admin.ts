import z from "zod/v4";
import {
  DATA_JOB_STATUSES,
  JOB_STAGE_STATUSES,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
} from "../../jobs/vocabulary";
import { opsFailureResultSchema, processDiagnosticsSchema } from "../../ops/job-evidence";
export const adminJobObservationSchema = z.strictObject({
  state: z.literal("unknown"),
  reason: z.enum([
    "transport",
    "observer_deadline",
    "recovery_required",
    "unavailable",
    "invalid_identity",
  ]),
  nextCheckAt: z.iso.datetime(),
});
export const adminJobEvidenceSchema = opsFailureResultSchema.safeExtend({
  observation: adminJobObservationSchema.optional(),
  diagnostics: processDiagnosticsSchema.optional(),
});

import {
  type AdminOperation,
  adminCommonResponses,
  adminCountSchema,
  adminJson,
  adminJsonValueSchema,
  adminStream,
  adminTimestampSchema,
  httpErrorSchema,
} from "./admin";

export const adminActivityJobSourceSchema = z.enum([
  "application",
  "data-manager",
  "integration-task",
]);
export const adminApplicationJobStatusSchema = z.enum(JOB_STATUSES);
export const adminDataManagerActivityJobStatusSchema = z.enum(DATA_JOB_STATUSES);
export const adminActorSummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});
const fields = {
  id: z.string(),
  type: z.string(),
  payload: adminJsonValueSchema,
  error: z.string().nullable(),
  progress: z.number().finite().nullable(),
  createdBy: z.string().nullable(),
  actorLabel: z.string(),
  createdAt: adminTimestampSchema,
  startedAt: adminTimestampSchema.nullable(),
  finishedAt: adminTimestampSchema.nullable(),
  cancelable: z.boolean(),
};
const application = z.strictObject({
  ...fields,
  source: z.literal("application"),
  status: adminApplicationJobStatusSchema,
});
const dataManager = z.strictObject({
  ...fields,
  source: z.literal("data-manager"),
  status: adminDataManagerActivityJobStatusSchema,
});
/**
 * One run of a task an integration scheduled: `type` is
 * `<integrationId>:<taskName>`, and a run that succeeded is `succeeded`, as
 * a job of the other sources is.
 */
const integrationTask = z.strictObject({
  ...fields,
  source: z.literal("integration-task"),
  status: z.enum(["running", "succeeded", "failed"]),
  cancelable: z.literal(false),
});
export const adminActivityJobSchema = z.discriminatedUnion("source", [
  application.extend({ actor: adminActorSummarySchema.nullable() }),
  dataManager.extend({ actor: adminActorSummarySchema.nullable() }),
  integrationTask.extend({ actor: z.null() }),
]);
/** One line of a job's log; `seq` is its position, unique within the job. */
export const adminActivityJobLogSchema = z.strictObject({
  jobId: z.string(),
  seq: adminCountSchema,
  stream: z.enum(["stdout", "stderr"]),
  line: z.string(),
  createdAt: adminTimestampSchema,
});
export const adminActivityJobStageSchema = z.strictObject({
  id: z.string(),
  jobId: z.string(),
  stage: z.string(),
  status: z.enum(JOB_STAGE_STATUSES),
  startedAt: adminTimestampSchema,
  finishedAt: adminTimestampSchema,
  durationMs: adminCountSchema,
  message: z.string().nullable(),
  error: adminJsonValueSchema,
  artifacts: adminJsonValueSchema,
});
// Historical JSON results remain supported; known evidence members are strict.
export const adminActivityJobResultSchema = adminJsonValueSchema.superRefine((value, ctx) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (Object.keys(value).some((key) => key.startsWith("_")))
    ctx.addIssue({ code: "custom", message: "Internal administrative job state" });
  const evidence = Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      ["serviceBatch", "dataWorkflow", "serviceLifecycle", "diagnostics", "observation"].includes(
        key,
      ),
    ),
  );
  if (!adminJobEvidenceSchema.safeParse(evidence).success)
    ctx.addIssue({ code: "custom", message: "Invalid administrative job evidence" });
});
const detail = {
  result: adminActivityJobResultSchema,
  logs: z.array(adminActivityJobLogSchema),
  stages: z.array(adminActivityJobStageSchema),
};
export const adminApplicationActivityJobDetailSchema = application.extend(detail);
export const adminDataManagerActivityJobDetailSchema = dataManager.extend(detail);
export const adminActivityJobDetailSchema = z.discriminatedUnion("source", [
  adminApplicationActivityJobDetailSchema,
  adminDataManagerActivityJobDetailSchema,
  integrationTask.extend({
    ...detail,
    logs: z.array(adminActivityJobLogSchema).max(0),
    stages: z.array(adminActivityJobStageSchema).max(0),
  }),
]);
export const adminActivityJobsResponseSchema = z.strictObject({
  jobs: z.array(adminActivityJobSchema),
  total: adminCountSchema,
});
export const adminJobStreamMetricsSchema = z.strictObject({
  activeStreams: adminCountSchema,
  reconnects: adminCountSchema,
  backfilledEvents: adminCountSchema,
  snapshotFallbacks: adminCountSchema,
  droppedEvents: adminCountSchema,
  publishedEvents: adminCountSchema,
  maxPublishLagMs: z.number().nonnegative(),
  handlerDurationMs: z.array(
    z.strictObject({ upperBoundMs: z.number().nonnegative().nullable(), count: adminCountSchema }),
  ),
  handlerDurations: z.strictObject({
    count: adminCountSchema,
    totalMs: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
  }),
});
const terminal = z.enum(TERMINAL_JOB_STATUSES);
export const adminJobStreamEventSchemas = {
  snapshot: z.strictObject({ job: adminApplicationActivityJobDetailSchema }),
  status: z.strictObject({
    type: z.literal("status"),
    status: adminApplicationJobStatusSchema,
    progress: z.number().finite().nullable().optional(),
    error: z.string().nullable().optional(),
    result: adminActivityJobResultSchema.optional(),
    startedAt: adminTimestampSchema.nullable().optional(),
    finishedAt: adminTimestampSchema.nullable().optional(),
  }),
  progress: z.strictObject({ type: z.literal("progress"), progress: z.number().finite() }),
  log: adminActivityJobLogSchema.omit({ jobId: true }).extend({ type: z.literal("log") }),
  end: z.strictObject({ status: terminal }),
  overflow: z.strictObject({ reason: z.literal("slow consumer") }),
} as const;
export type AdminJobStreamEvents = {
  [K in keyof typeof adminJobStreamEventSchemas]: z.infer<(typeof adminJobStreamEventSchemas)[K]>;
};
export type AdminActivityJob = z.infer<typeof adminActivityJobSchema>;
export type AdminActivityJobDetail = z.infer<typeof adminActivityJobDetailSchema>;
export type AdminActivityJobLog = z.infer<typeof adminActivityJobLogSchema>;
export type AdminActivityJobStage = z.infer<typeof adminActivityJobStageSchema>;
export type AdminActivityJobSource = z.infer<typeof adminActivityJobSourceSchema>;
export type AdminActivityJobsResponse = z.infer<typeof adminActivityJobsResponseSchema>;
export type AdminJobStreamMetrics = z.infer<typeof adminJobStreamMetricsSchema>;
// Query parsing accepts exact decimal digits, never JavaScript's null/blank/array coercions.
// Route metadata emits output mode, so OpenAPI exposes integer bounds and defaults.
const integerQuery = (min: number, max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value),
    z.number().int().safe().min(min).max(max),
  );
export const adminActivityJobsQuerySchema = z.strictObject({
  status: z.enum(["active", "completed", "failed"]).optional(),
  limit: integerQuery(1, 200).default(50),
  offset: integerQuery(0, Number.MAX_SAFE_INTEGER).default(0),
});
export const adminActivityJobParamsSchema = z.strictObject({ id: z.uuid() });
export const adminActivityJobQuerySchema = z.strictObject({
  source: adminActivityJobSourceSchema.optional(),
});
export const adminActivityJobStreamQuerySchema = z.strictObject({
  source: z.literal("application").optional(),
  cursor: integerQuery(0, Number.MAX_SAFE_INTEGER).optional(),
});
export const adminActivityJobStreamHeadersSchema = z.object({
  "last-event-id": integerQuery(0, Number.MAX_SAFE_INTEGER).optional(),
});
const common = adminCommonResponses;
export const activityAdminOperations = {
  listAdminActivityJobs: {
    method: "GET",
    path: "/api/admin/jobs",
    auth: "admin",
    request: { query: adminActivityJobsQuerySchema },
    responses: { ...common, 200: adminJson(adminActivityJobsResponseSchema) },
  },
  getAdminActivityJob: {
    method: "GET",
    path: "/api/admin/jobs/:id",
    auth: "admin",
    request: { params: adminActivityJobParamsSchema, query: adminActivityJobQuerySchema },
    responses: {
      ...common,
      200: adminJson(adminActivityJobDetailSchema),
      404: adminJson(httpErrorSchema),
    },
  },
  cancelAdminActivityJob: {
    method: "POST",
    path: "/api/admin/jobs/:id/cancel",
    auth: "admin",
    request: { params: adminActivityJobParamsSchema, query: adminActivityJobQuerySchema },
    responses: {
      ...common,
      200: adminJson(z.strictObject({ ok: z.literal(true) })),
      409: adminJson(httpErrorSchema),
    },
  },
  getAdminActivityJobStreamMetrics: {
    method: "GET",
    path: "/api/admin/jobs/stream-metrics",
    auth: "admin",
    responses: { ...common, 200: adminJson(adminJobStreamMetricsSchema) },
  },
  streamAdminActivityJobEvents: {
    method: "GET",
    path: "/api/admin/jobs/:id/events",
    auth: "admin",
    request: {
      params: adminActivityJobParamsSchema,
      query: adminActivityJobStreamQuerySchema,
      headers: adminActivityJobStreamHeadersSchema,
    },
    responses: {
      ...common,
      200: adminStream("text/event-stream"),
      404: adminJson(httpErrorSchema),
    },
  },
} as const satisfies Record<string, AdminOperation>;
