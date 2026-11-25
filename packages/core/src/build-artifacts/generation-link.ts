/**
 * A configuration generation's hardlink plan, applied by data-manager through
 * its `/link` route. Every issuer (agent maintenance and operations, artifact
 * imports, data updates, the fixed lifecycles and the host CLI) sends the plan
 * the current generation names, with the lease its own operation holds.
 * Data-manager then admits the application under that lease, or under the
 * prepared fence of that operation's maintenance, without a lease of its own.
 *
 * The application is keyed by the issuing operation and the revision: a
 * request repeated after a lost answer observes the first one, and applying
 * the same plan again links nothing new.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createControlRootOperationKey } from "../ops/control-root-key";
import { type HardlinkApplySummary, hardlinkApplySummarySchema } from "../ops/service-results";
import { currentConfigurationGeneration } from "../services/configuration-generation";
import type { HardlinkEntry } from "../services/data-manager/contracts/datasets";
import {
  type DataExecutionStatus,
  dataExecutionStatusSchema,
  generationHardlinksPlanSchema,
  isDataExecutionTerminal,
} from "../services/data-manager/contracts/executions";
import {
  link,
  lookupDataExecution,
} from "../services/data-manager/generated/data-manager.generated";
import {
  DataManagerContractError,
  type DataManagerTransport,
} from "../services/data-manager/transport";
import {
  CONFIGURATION_GENERATIONS,
  currentConfigurationFile,
  GENERATED_HARDLINK_PLAN_FILE,
} from "../services/deployment";

const NOTHING_TO_LINK: HardlinkApplySummary = Object.freeze({
  applied: true,
  entries: 0,
  linked: 0,
  skipped: 0,
  pruned: 0,
  via: "none",
});

/** Data-manager did not apply the plan: it is busy, unreachable, or refused the request. */
export class GenerationLinkNotApplied extends Error {
  constructor(
    readonly reason: "busy" | "unavailable" | "refused",
    message: string,
  ) {
    super(message);
    this.name = "GenerationLinkNotApplied";
  }
}
/** Data-manager answered that the application failed after it may have changed links. */
export class GenerationLinkFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationLinkFailed";
  }
}
/** No answer before the issuer's deadline: data-manager may still apply the plan. */
export class GenerationLinkUnknown extends Error {
  constructor(readonly operationKey: string) {
    super(`Data-manager did not report the outcome of hardlink application ${operationKey}`);
    this.name = "GenerationLinkUnknown";
  }
}

/** The plan of the current generation, refused when the generation is no longer `revisionId`. */
export function readGenerationHardlinkPlan(infraDir: string, revisionId: string) {
  if (currentConfigurationGeneration(infraDir) !== revisionId)
    throw Error("Hardlink generation conflict");
  const plan = generationHardlinksPlanSchema.parse({
    plan: JSON.parse(
      readFileSync(currentConfigurationFile(infraDir, GENERATED_HARDLINK_PLAN_FILE), "utf8"),
    ),
    prune: true,
  });
  if (currentConfigurationGeneration(infraDir) !== revisionId)
    throw Error("Hardlink generation conflict");
  return plan;
}

/** The key of one issuing operation's application of one revision's plan. It
 * expires with the issuer, so a restarted issuer names the same application. */
export function generationLinkOperationKey(
  issuer: { operationKey: string; deadlineAt: number },
  revisionId: string,
): string {
  return createControlRootOperationKey({
    notAfter: issuer.deadlineAt,
    nonce: createHash("sha256")
      .update(`openmapx-generation-link-v1\0${issuer.operationKey}\0${revisionId}`)
      .digest()
      .subarray(0, 16),
  });
}

/**
 * Sends the plan to data-manager and waits for its outcome. A lost answer, an
 * application data-manager reports as still running, and an unavailable or
 * busy answer after a lost one are asked again under the same key for up to
 * two minutes, never past `deadlineAt`; after that the outcome is unknown.
 * Asking again later under the same key resolves it.
 */
export async function linkGeneration(options: {
  transport: DataManagerTransport;
  operationKey: string;
  deadlineAt: number;
  revisionId: string;
  plan: HardlinkEntry[];
  prune: boolean;
  leaseId: string | null;
  signal?: AbortSignal;
}): Promise<HardlinkApplySummary> {
  const body = {
    operationKey: options.operationKey,
    requestedDeadlineAt: options.deadlineAt,
    revisionId: options.revisionId,
    plan: options.plan,
    prune: options.prune,
    ...(options.leaseId ? { leaseId: options.leaseId } : {}),
  };
  // Set once a request may have reached data-manager without its outcome.
  let pending = false;
  // Long enough for data-manager or the agent to restart, never past the issuer.
  const retryUntil = Math.min(options.deadlineAt, Date.now() + 120_000);
  for (let attempt = 0; ; attempt += 1) {
    let response: Awaited<ReturnType<typeof link>> | undefined;
    try {
      options.signal?.throwIfAborted();
      response = await link(body, { transport: options.transport, signal: options.signal });
    } catch (error) {
      if (error instanceof DataManagerContractError) throw error;
      if (!pending && attempt === 0 && !options.signal?.aborted && isConnectionRefused(error))
        throw new GenerationLinkNotApplied(
          "unavailable",
          "Data-manager is not reachable to apply the hardlink plan",
        );
      pending = true;
    }
    if (response?.status === 200)
      return hardlinkApplySummarySchema.parse({
        applied: true,
        entries: options.plan.length,
        linked: response.data.linked,
        skipped: response.data.skipped,
        pruned: response.data.pruned,
        via: "data-manager",
      });
    // A refusal is an answer: nothing was linked. After an unanswered request,
    // a 503 may be data-manager restarting under it, and a busy admission may be
    // that request's own copy still inside its admission, about to link: both
    // are asked again.
    if (response && response.status !== 202) {
      const message = errorMessage(response.data, response.status);
      const askAgain =
        pending &&
        (response.status === 503 ||
          (response.status === 409 && message === "configuration_maintenance_busy"));
      if (!askAgain) {
        if (response.status === 500) throw new GenerationLinkFailed(message);
        throw new GenerationLinkNotApplied(
          response.status === 409 ? "busy" : response.status === 503 ? "unavailable" : "refused",
          message,
        );
      }
    }
    if (response?.status === 202) pending = true;
    const delayMs = Math.min(250 * 2 ** attempt, 5000);
    if (options.signal?.aborted || Date.now() + delayMs >= retryUntil) {
      if (pending) throw new GenerationLinkUnknown(options.operationKey);
      throw new GenerationLinkNotApplied(
        "unavailable",
        response ? errorMessage(response.data, response.status) : "Data-manager is unavailable",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/** The reason data-manager gave: a thrown error's message, else its `error` field. */
function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object") {
    if ("message" in data && typeof data.message === "string") return data.message;
    if ("error" in data && typeof data.error === "string") return data.error;
  }
  return `Data-manager HTTP ${status}`;
}
function isConnectionRefused(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause)
    if ((cause as NodeJS.ErrnoException).code === "ECONNREFUSED") return true;
  return false;
}

/** Applies the current generation's plan for an issuing operation that holds `leaseId`. */
export async function applyGenerationLinks(options: {
  infraDir: string;
  revisionId: string;
  transport: DataManagerTransport;
  issuer: { operationKey: string; deadlineAt: number };
  leaseId: string | null;
  signal?: AbortSignal;
}): Promise<HardlinkApplySummary> {
  const frozen = readGenerationHardlinkPlan(options.infraDir, options.revisionId);
  if (!frozen.plan.length) return NOTHING_TO_LINK;
  return linkGeneration({
    transport: options.transport,
    operationKey: generationLinkOperationKey(options.issuer, options.revisionId),
    deadlineAt: options.issuer.deadlineAt,
    revisionId: options.revisionId,
    plan: frozen.plan,
    prune: true,
    leaseId: options.leaseId,
    signal: options.signal,
  });
}

/**
 * What became of an issuing operation's application, read without sending it:
 * for recovery after the issuer stopped. `pending` while data-manager still
 * runs it or has not reported its outcome.
 */
export async function inspectGenerationLinks(options: {
  infraDir: string;
  transport: DataManagerTransport;
  issuer: { operationKey: string; deadlineAt: number };
  revisionId: string;
  signal?: AbortSignal;
}): Promise<"not_attempted" | "complete" | "failed" | "pending"> {
  // A generation whose plan names nothing was never sent.
  if (!/^cfg1_[A-Za-z0-9_-]{43}$/.test(options.revisionId))
    throw Error("Hardlink generation conflict");
  const frozen = generationHardlinksPlanSchema.parse({
    plan: JSON.parse(
      readFileSync(
        join(
          options.infraDir,
          CONFIGURATION_GENERATIONS,
          options.revisionId,
          GENERATED_HARDLINK_PLAN_FILE,
        ),
        "utf8",
      ),
    ),
    prune: true,
  });
  if (!frozen.plan.length) return "complete";
  const response = await lookupDataExecution(
    generationLinkOperationKey(options.issuer, options.revisionId),
    { transport: options.transport, signal: options.signal },
  );
  if (response.status === 404) return "not_attempted";
  if (response.status !== 200) return "pending";
  const status: DataExecutionStatus = dataExecutionStatusSchema.parse(response.data);
  if (status.kind !== "generation-link") throw Error("Hardlink application identity conflict");
  if (!isDataExecutionTerminal(status)) return "pending";
  return status.status === "succeeded" ? "complete" : "failed";
}
