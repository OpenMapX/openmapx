/** Private, bounded original-job cursor. This correlates installer phases; every
 * host effect still requires the normal typed broker and original deadline. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, readOpsTokenFile } from "@openmapx/core/ops";
import { envString } from "@openmapx/core/server-env";
import { z } from "zod";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { JobObservationPending } from "./admin-job-failure";
import { jobOwnership } from "./admin-job-state";
import type { JobContext } from "./job-runner";

const stepSchema = z.strictObject({
  input: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["attempted", "complete"]),
  result: z.unknown().optional(),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  jobId: z.uuid(),
  type: z.enum(["extension.install", "extension.remove"]),
  intent: z.string(),
  steps: z
    .record(z.string().max(200), stepSchema)
    .refine((value) => Object.keys(value).length <= 256),
});
type State = z.infer<typeof stateSchema>;
export interface ExtensionWorkflow {
  readonly jobId: string;
}
const owners = new WeakMap<ExtensionWorkflow, { ctx: JobContext; state: State }>();
const digest = (value: unknown) =>
  createHash("sha256")
    .update(canonicalJson(value ?? null))
    .digest("hex");
const fail = (): never => {
  throw new JobObservationPending("recovery_required");
};
const token = () => readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", ""));
async function seal(state: State) {
  const body = canonicalJson(stateSchema.parse(state));
  if (Buffer.byteLength(body) > 1024 * 1024) return fail();
  return {
    body,
    mac: createHmac("sha256", await token())
      .update("openmapx-extension-workflow-v1\0")
      .update(body)
      .digest("hex"),
  };
}
async function read(value: unknown) {
  const saved = z
    .strictObject({ body: z.string().max(1024 * 1024), mac: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(value);
  const expected = createHmac("sha256", await token())
    .update("openmapx-extension-workflow-v1\0")
    .update(saved.body)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(saved.mac, "hex"))) return fail();
  return stateSchema.parse(JSON.parse(saved.body));
}
export async function openExtensionWorkflow(
  ctx: JobContext,
  intent: unknown,
): Promise<ExtensionWorkflow> {
  if (!ctx.execution || !["extension.install", "extension.remove"].includes(ctx.jobType ?? ""))
    return fail();
  const original = digest({ payload: ctx.payload, intent });
  const state: State =
    ctx.checkpointResult?._extensionWorkflow === undefined
      ? {
          version: 1,
          jobId: ctx.jobId,
          type: ctx.jobType as State["type"],
          intent: original,
          steps: {},
        }
      : await read(ctx.checkpointResult._extensionWorkflow);
  if (state.jobId !== ctx.jobId || state.type !== ctx.jobType || state.intent !== original)
    return fail();
  const handle = Object.freeze({ jobId: ctx.jobId });
  owners.set(handle, { ctx, state });
  if (ctx.checkpointResult?._extensionWorkflow === undefined) {
    if (ctx.observationOnly) return fail();
    await ctx.checkpoint({ ...ctx.checkpointResult, _extensionWorkflow: await seal(state) });
  }
  return handle;
}
function owner(handle: ExtensionWorkflow) {
  const value = owners.get(handle);
  if (!value) return fail();
  return value;
}
export async function extensionStep<T>(
  handle: ExtensionWorkflow,
  name: string,
  input: unknown,
  effect: () => Promise<T>,
): Promise<T> {
  const { ctx, state } = owner(handle),
    fingerprint = digest(input),
    prior = state.steps[name];
  if (prior && prior.input !== fingerprint) return fail();
  if (prior?.state === "complete") return structuredClone(prior.result) as T;
  ctx.signal.throwIfAborted();
  if (!prior) {
    state.steps[name] = { input: fingerprint, state: "attempted" };
    await ctx.checkpoint({ ...ctx.checkpointResult, _extensionWorkflow: await seal(state) });
  }
  const result = await effect();
  const next = {
    ...state,
    steps: {
      ...state.steps,
      [name]: { input: fingerprint, state: "complete" as const, result: result ?? null },
    },
  };
  await ctx.checkpoint({ ...ctx.checkpointResult, _extensionWorkflow: await seal(next) });
  state.steps = next.steps;
  return result;
}
/** Lock the actual administrative owner before bookkeeping and publish its
 * completion cursor in that SAME transaction. A reclaimed owner cannot commit. */
export async function extensionDatabaseStep<T>(
  handle: ExtensionWorkflow,
  name: string,
  input: unknown,
  write: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  const { ctx, state } = owner(handle),
    fingerprint = digest(input),
    prior = state.steps[name];
  if (prior && prior.input !== fingerprint) return fail();
  if (prior?.state === "complete") return structuredClone(prior.result) as T;
  let committed: Record<string, unknown> | undefined;
  let next: State | undefined;
  const result = await db
    .transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(adminJob)
        .where(jobOwnership(ctx.jobId, ctx.execution))
        .for("update");
      if (
        !row ||
        row.type !== ctx.jobType ||
        canonicalJson(row.payload) !== canonicalJson(ctx.payload)
      )
        return fail();
      const current = (row.result ?? {}) as Record<string, unknown>,
        retained = await read(current._extensionWorkflow);
      if (canonicalJson(retained) !== canonicalJson(state)) return fail();
      const output = await write(tx);
      next = {
        ...state,
        steps: {
          ...state.steps,
          [name]: { input: fingerprint, state: "complete", result: output ?? null },
        },
      };
      committed = { ...current, _extensionWorkflow: await seal(next) };
      const rows = await tx
        .update(adminJob)
        .set({ result: committed })
        .where(jobOwnership(ctx.jobId, ctx.execution))
        .returning({ id: adminJob.id });
      if (rows.length !== 1) return fail();
      return output;
    })
    .catch((error) => {
      // These server transaction-abort codes prove no bookkeeping commit.
      // Lost COMMIT acknowledgement and all unclassified I/O remain unknown.
      const source = error as { code?: unknown; cause?: { code?: unknown } };
      const code = source?.code ?? source?.cause?.code;
      if (typeof code === "string" && ["23503", "23505", "23514", "40001", "40P01"].includes(code))
        throw error;
      return fail();
    });
  if (!committed || !next) return fail();
  ctx.checkpointResult = committed;
  state.steps = next.steps;
  return result;
}
/** Routing only; openExtensionWorkflow authenticates this before any work. */
export function hasRetainedExtensionWorkflow(job: { type: string; result: unknown }) {
  const state = (job.result as Record<string, unknown> | null)?._extensionWorkflow;
  return ["extension.install", "extension.remove"].includes(job.type) && state !== undefined;
}

export function completedExtensionStep<T>(handle: ExtensionWorkflow, name: string): T | undefined {
  const step = owner(handle).state.steps[name];
  return step?.state === "complete" ? (structuredClone(step.result) as T) : undefined;
}

export const readExtensionWorkflow = read;

export function hasExtensionPublications(handle: ExtensionWorkflow): boolean {
  return Object.keys(owner(handle).state.steps).some(
    (name) => name.startsWith("repository.publish:") || name.startsWith("integration.publish:"),
  );
}
