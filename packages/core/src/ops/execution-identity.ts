import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { OPS_KIND_POLICIES, type OpsOperationKind } from "./contract";
import { canonicalJson } from "./fingerprint";

export type ControlIssuer = "ops-agent" | "data-manager" | "host-cli";
export const executionRefSchema = z
  .strictObject({
    executor: z.enum(["ops-agent", "data-manager", "host-cli"]),
    principal: z.enum(["api", "data-manager", "host-cli"]),
    executionId: z.string(),
    operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
    operationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    deadlineAt: z.number().int().nonnegative().safe(),
  })
  .refine((x) =>
    x.executor === "ops-agent"
      ? /^job1_[A-Za-z0-9_-]{16,64}$/.test(x.executionId)
      : z.uuid().safeParse(x.executionId).success,
  );
export type ExecutionRef = z.infer<typeof executionRefSchema>;

const apiParentIdentitySchema = z.strictObject({
  issuer: z.literal("api"),
  apiJobId: z.uuid(),
  apiOwnerVersion: z.number().int().positive().safe(),
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  deadlineAt: z.number().int().nonnegative().safe(),
  attemptId: z.uuid(),
  assertionDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const roleParentIdentitySchema = z
  .strictObject({
    issuer: z.enum(["ops-agent", "data-manager", "host-cli"]),
    execution: executionRefSchema,
    operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    deadlineAt: z.number().int().nonnegative().safe(),
  })
  .refine(
    (p) =>
      p.issuer === p.execution.executor &&
      p.operationKey === p.execution.operationKey &&
      p.fingerprint === p.execution.fingerprint &&
      p.deadlineAt === p.execution.deadlineAt,
  );
const parentIdentitySchema = z.union([apiParentIdentitySchema, roleParentIdentitySchema]);
/** Persisted identity is evidence only; parsing it does not authenticate a parent. */
export type RetainedParentExecution = z.infer<typeof parentIdentitySchema>;
declare const verifiedParent: unique symbol;
export type VerifiedParentExecution = Readonly<RetainedParentExecution> & {
  readonly [verifiedParent]: true;
};

import { verifiedParents } from "./verified-parent-internal";
export type ExecutionAdmission = { requestedDeadlineAt?: number; parent?: VerifiedParentExecution };
export const retainedParentExecutionSchema = parentIdentitySchema;
export const OPS_MAX_EXECUTION_MS = 7 * 24 * 3600_000;
export const OPS_SETTLEMENT_MS = 30_000 as const;
const futureBudgets: Readonly<Record<string, number>> = {
  "artifactTransfer.import": 72 * 3600_000,
  "artifactTransfer.export": 72 * 3600_000,
  "artifactTransfer.validate": 72 * 3600_000,
  "catalog.validate": 72 * 3600_000,
  "catalog.activate": 3600_000,
  "data.overturePull": 24 * 3600_000,
  "data.overtureIngest": 24 * 3600_000,
  "data.overtureExtract": 24 * 3600_000,
  "platform.config.apply": 3600_000,
  "download-osm": 24 * 3600_000,
  "download-fonts": 24 * 3600_000,
  "convert-overpass": 24 * 3600_000,
  "transit-sync": 24 * 3600_000,
  "overture-pull": 24 * 3600_000,
  "overture-ingest": 24 * 3600_000,
  "overture-extract": 24 * 3600_000,
  "overture-conflate": 24 * 3600_000,
  "overture-sync": 24 * 3600_000,
  "search-index-build": 24 * 3600_000,
  "notable-places-build": 24 * 3600_000,
  "generation-hardlinks": 10 * 60_000,
  "transit-maintenance": 120_000,
};
/** Future policies are budgets only; they register no executable operations. */
export function opsExecutionBudget(kind: string): { processMs: number; settlementMs: 30000 } {
  const policy = Object.hasOwn(OPS_KIND_POLICIES, kind)
    ? OPS_KIND_POLICIES[kind as OpsOperationKind]
    : undefined;
  const processMs =
    policy?.timeoutMs ?? (Object.hasOwn(futureBudgets, kind) ? futureBudgets[kind] : undefined);
  if (!processMs) throw Error("Unknown execution kind");
  return { processMs, settlementMs: OPS_SETTLEMENT_MS };
}
export function opsExecutionMaximumMs(kind: string): number {
  return [
    "artifactTransfer.import",
    "artifactTransfer.export",
    "artifactTransfer.validate",
  ].includes(kind)
    ? OPS_MAX_EXECUTION_MS
    : opsExecutionBudget(kind).processMs;
}
export function executionFingerprint(input: {
  kind: string;
  operationFingerprint: string;
  deadlineAt: number;
  parent?: RetainedParentExecution;
}): string {
  return createHash("sha256")
    .update("openmapx-execution-v2\0")
    .update(canonicalJson({ version: 2, ...input }))
    .digest("hex");
}
function epoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
export function normalizeExecutionAdmission(input: {
  operationFingerprint: string;
  operationKey: string;
  kind: string;
  admittedAt: number;
  requestedDeadlineAt?: number;
  parent?: VerifiedParentExecution;
  deploymentBudgetMs?: number;
}): { admittedAt: number; deadlineAt: number; fingerprint: string } {
  const budget = opsExecutionBudget(input.kind).processMs;
  const deploymentBudget = input.deploymentBudgetMs ?? budget;
  if (
    !epoch(input.admittedAt) ||
    !/^[a-f0-9]{64}$/.test(input.operationFingerprint) ||
    !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(input.operationKey) ||
    !Number.isSafeInteger(deploymentBudget) ||
    deploymentBudget <= 0 ||
    (input.requestedDeadlineAt !== undefined && !epoch(input.requestedDeadlineAt)) ||
    (input.parent &&
      (!verifiedParents.has(input.parent) || input.requestedDeadlineAt === undefined))
  )
    throw Error("Invalid execution admission");
  const deadlineAt = Math.min(
    input.requestedDeadlineAt ?? input.admittedAt + budget,
    input.parent?.deadlineAt ?? Infinity,
    input.admittedAt + Math.min(opsExecutionMaximumMs(input.kind), deploymentBudget),
  );
  if (!epoch(deadlineAt) || deadlineAt <= input.admittedAt)
    throw Error("Elapsed execution deadline");
  return {
    admittedAt: input.admittedAt,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind: input.kind,
      operationFingerprint: input.operationFingerprint,
      deadlineAt,
      ...(input.parent ? { parent: input.parent } : {}),
    }),
  };
}

const apiAssertionSchema = z.strictObject({
  version: z.literal(1),
  apiJobId: z.uuid(),
  apiOwnerVersion: z.number().int().positive().safe(),
  parentOperationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  parentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  parentDeadlineAt: z.number().int().nonnegative().safe(),
  childOperationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  childOperationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestedDeadlineAt: z.number().int().nonnegative().safe(),
  attemptId: z.uuid(),
});
/** Fixed API bearer/HMAC edge only. Role-signed parent/lease verification belongs to 06.1. */
export function verifyApiJobParentExecution(
  assertion: string,
  token: string,
  child: { operationKey: string; operationFingerprint: string; requestedDeadlineAt?: number },
): VerifiedParentExecution {
  if (assertion.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(assertion))
    throw Error("Invalid parent assertion");
  const [payload, signature] = assertion.split(".") as [string, string];
  const expected = createHmac("sha256", token)
    .update("openmapx-api-job-parent-v1\0")
    .update(payload)
    .digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
    throw Error("Invalid parent assertion");
  const fields = apiAssertionSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64url"))),
  );
  if (
    Buffer.from(JSON.stringify(fields)).toString("base64url") !== payload ||
    fields.childOperationKey !== child.operationKey ||
    fields.childOperationFingerprint !== child.operationFingerprint ||
    fields.requestedDeadlineAt !== child.requestedDeadlineAt
  )
    throw Error("Invalid parent binding");
  const parent = Object.freeze({
    issuer: "api" as const,
    apiJobId: fields.apiJobId,
    apiOwnerVersion: fields.apiOwnerVersion,
    operationKey: fields.parentOperationKey,
    fingerprint: fields.parentFingerprint,
    deadlineAt: fields.parentDeadlineAt,
    attemptId: fields.attemptId,
    assertionDigest: createHash("sha256").update(assertion).digest("hex"),
  });
  verifiedParents.add(parent);
  return parent as VerifiedParentExecution;
}

export interface RetainedExecutionAdmission {
  executionVersion: 2;
  admittedAt: number;
  deadlineAt: number;
  operationFingerprint: string;
  fingerprint: string;
  requestedDeadlineAt?: number;
  parent?: RetainedParentExecution;
  deploymentBudgetMs: number;
}
/** Restart validation recomputes evidence; it never manufactures verified parent authority. */
export function validateRetainedExecutionAdmission(
  kind: string,
  input: RetainedExecutionAdmission,
): void {
  const budget = opsExecutionBudget(kind).processMs;
  const parent =
    input.parent === undefined ? undefined : retainedParentExecutionSchema.parse(input.parent);
  if (
    input.executionVersion !== 2 ||
    !epoch(input.admittedAt) ||
    !epoch(input.deadlineAt) ||
    !Number.isSafeInteger(input.deploymentBudgetMs) ||
    input.deploymentBudgetMs <= 0 ||
    input.deploymentBudgetMs > opsExecutionMaximumMs(kind) ||
    (input.requestedDeadlineAt !== undefined && !epoch(input.requestedDeadlineAt)) ||
    (parent && input.requestedDeadlineAt === undefined) ||
    input.deadlineAt <= input.admittedAt ||
    input.deadlineAt !==
      Math.min(
        input.requestedDeadlineAt ?? input.admittedAt + budget,
        parent?.deadlineAt ?? Infinity,
        input.admittedAt + input.deploymentBudgetMs,
      ) ||
    input.fingerprint !==
      executionFingerprint({
        kind,
        operationFingerprint: input.operationFingerprint,
        deadlineAt: input.deadlineAt,
        ...(parent ? { parent } : {}),
      })
  )
    throw Error("Invalid retained execution");
}
