import { createHash } from "node:crypto";
import { transitPinOperations } from "@openmapx/core/api-contracts";
import {
  type DataExecutionInput,
  type DataExecutionStatus,
  normalizeDataExecutionInput,
} from "@openmapx/core/data-manager-contracts";
import * as dm from "@openmapx/core/data-manager-sdk";
import { canonicalJson, executionFingerprint, opsExecutionBudget } from "@openmapx/core/ops";
import { envString } from "@openmapx/core/server-env";
import type { FastifyInstance } from "fastify";
import {
  TransitPinRequestConflict,
  transitPinRequestIdentity,
} from "../services/transit-pin-requests";
import { writeAuditLog } from "../utils/audit-log";
import { RateLimiter } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { createAdminRouteRegistrar } from "./admin-contract";

const register = createAdminRouteRegistrar(transitPinOperations, {
  tag: "data-manager-admin",
  validationPhase: "preHandler",
});
function transport(long = false) {
  return dm.createDataManagerTransport({
    baseUrl: envString("DATA_MANAGER_URL", "http://localhost:4000"),
    authToken: envString("DATA_MANAGER_AUTH_TOKEN", ""),
    requestTimeoutMs: long ? 120000 : 15000,
    maxJsonBytes: 8 * 1024 * 1024,
  });
}
type CatalogInput = Extract<DataExecutionInput, { kind: "catalog.validate" | "catalog.activate" }>;
function matched(
  status: DataExecutionStatus,
  input: CatalogInput,
  identity: ReturnType<typeof transitPinRequestIdentity>,
) {
  const operationFingerprint = createHash("sha256")
    .update(canonicalJson(normalizeDataExecutionInput(input)))
    .digest("hex");
  if (
    status.operationKey !== identity.operationKey ||
    status.kind !== input.kind ||
    status.deadlineAt > identity.deadlineAt ||
    status.fingerprint !==
      executionFingerprint({
        kind: input.kind,
        operationFingerprint,
        deadlineAt: status.deadlineAt,
      })
  )
    throw new TransitPinRequestConflict(
      "This request identity belongs to a different catalog operation",
    );
  return status;
}
async function submit(
  input: CatalogInput,
  actor: string,
  key: unknown,
): Promise<DataExecutionStatus> {
  const identity = transitPinRequestIdentity(actor, key),
    connection = transport();
  const existing = await dm.lookupDataExecution(identity.operationKey, { transport: connection });
  if (existing.status !== 404)
    return matched(dm.unwrapDataManagerResponse(existing), input, identity);
  if (
    identity.deadlineAt <= Date.now() ||
    identity.deadlineAt > Date.now() + opsExecutionBudget(input.kind).processMs + 5000
  )
    throw new TransitPinRequestConflict(
      "Catalog request expired or exceeds its time budget. Refresh review and check the device clock.",
    );
  try {
    return matched(
      dm.unwrapDataManagerResponse(
        await dm.startDataExecution(
          { input, operationKey: identity.operationKey, requestedDeadlineAt: identity.deadlineAt },
          { transport: connection },
        ),
      ),
      input,
      identity,
    );
  } catch (error) {
    // An accepted root can outlive a lost admission response. Read its original
    // address; never resubmit the mutation in this observation continuation.
    if (error instanceof dm.DataManagerHttpError) throw error;
    const retained = await dm.lookupDataExecution(identity.operationKey, { transport: connection });
    if (retained.status !== 404)
      return matched(dm.unwrapDataManagerResponse(retained), input, identity);
    throw error;
  }
}
export async function adminTransitPinsRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
  });
  const limits = new RateLimiter({
    max: 12,
    windowMs: 60000,
    keyFn: (request) => getAdminSession(request).user.id,
  });
  app.addHook("onClose", async () => limits.destroy());
  const failure = (error: unknown) => ({
    status:
      error instanceof TransitPinRequestConflict
        ? 409
        : error instanceof dm.DataManagerHttpError && [400, 404, 409, 422].includes(error.status)
          ? error.status
          : 503,
    error:
      error instanceof TransitPinRequestConflict
        ? error.message
        : "Catalog operation is unavailable. Inspect the retained transit job before retrying.",
  });
  register(app, "getAdminTransitPins", async (request, reply) => {
    try {
      return dm.unwrapDataManagerResponse(
        await dm.inspectCatalogReview(request.query, { transport: transport() }),
      );
    } catch (error) {
      const rejected = failure(error);
      return reply.code(rejected.status).send({ error: rejected.error });
    }
  });
  register(
    app,
    "proposeAdminTransitPins",
    async (request, reply) => {
      const actor = getAdminSession(request).user.id;
      try {
        const identity = transitPinRequestIdentity(actor, request.headers["idempotency-key"]);
        const retained = dm.unwrapDataManagerResponse(
          await dm.inspectCatalogReview(
            { proposalId: identity.proposalId },
            { transport: transport() },
          ),
        );
        if (retained.proposal) {
          if (retained.proposal.pins.transitous.ref.split("@")[0] !== request.body.branch)
            throw new TransitPinRequestConflict(
              "This proposal identity belongs to a different branch",
            );
          return {
            proposalId: retained.proposal.proposalId,
            generationId: retained.proposal.pins.generationId,
          };
        }
        if (identity.deadlineAt <= Date.now() || identity.deadlineAt > Date.now() + 3600000 + 5000)
          throw new TransitPinRequestConflict(
            "Proposal request expired or exceeds its time budget",
          );
        // The immutable resolver retains this exact ID/body before its agent POST;
        // duplicate delivery reads that original source rather than refetching it.
        const created = dm.unwrapDataManagerResponse(
          await dm.proposeTransitBump(
            { branch: request.body.branch, proposalId: identity.proposalId },
            { transport: transport(true) },
          ),
        );
        if (created.unchanged)
          throw new TransitPinRequestConflict("Refresh review to select the current catalog pair");
        await writeAuditLog({
          actorId: actor,
          targetType: "transit",
          targetId: created.proposalId,
          action: "transit.catalog.propose",
          details: { branch: request.body.branch, generationId: created.catalogRevisionId },
          request,
        });
        return { proposalId: created.proposalId, generationId: created.catalogRevisionId };
      } catch (error) {
        const rejected = failure(error);
        return reply.code(rejected.status).send({ error: rejected.error });
      }
    },
    { beforeValidation: limits.preHandler() },
  );
  register(
    app,
    "validateAdminTransitPins",
    async (request, reply) => {
      const actor = getAdminSession(request).user.id;
      try {
        const job = await submit(
          {
            kind: "catalog.validate",
            proposalId: request.params.proposalId,
            countries: request.body.countries,
          },
          actor,
          request.headers["idempotency-key"],
        );
        await writeAuditLog({
          actorId: actor,
          targetType: "transit",
          targetId: request.params.proposalId,
          action: "transit.catalog.validate",
          details: { jobId: job.id, countries: request.body.countries },
          request,
        });
        return reply.code(202).send({ jobId: job.id });
      } catch (error) {
        const rejected = failure(error);
        return reply.code(rejected.status).send({ error: rejected.error });
      }
    },
    { beforeValidation: limits.preHandler() },
  );
  register(
    app,
    "activateAdminTransitPins",
    async (request, reply) => {
      const actor = getAdminSession(request).user.id;
      try {
        const job = await submit(
          { kind: "catalog.activate", proposalId: request.params.proposalId, ...request.body },
          actor,
          request.headers["idempotency-key"],
        );
        await writeAuditLog({
          actorId: actor,
          targetType: "transit",
          targetId: request.params.proposalId,
          action: "transit.catalog.activate",
          details: {
            jobId: job.id,
            validationId: request.body.validationId,
            diffDigest: request.body.diffDigest,
          },
          request,
        });
        return reply.code(202).send({ jobId: job.id });
      } catch (error) {
        const rejected = failure(error);
        return reply.code(rejected.status).send({ error: rejected.error });
      }
    },
    { beforeValidation: limits.preHandler() },
  );
  register(
    app,
    "cancelAdminTransitPinExecution",
    async (request, reply) => {
      try {
        const connection = transport(),
          current = dm.unwrapDataManagerResponse(
            await dm.getDataExecution(request.params.id, { transport: connection }),
          );
        if (
          !["catalog.validate", "catalog.activate"].includes(current.kind) ||
          current.operationKey !== request.body.operationKey ||
          current.fingerprint !== request.body.fingerprint
        )
          throw new TransitPinRequestConflict("Catalog execution identity changed");
        const canceled = dm.unwrapDataManagerResponse(
          await dm.cancelDataExecution(request.params.id, request.body, { transport: connection }),
        );
        await writeAuditLog({
          actorId: getAdminSession(request).user.id,
          targetType: "transit",
          targetId: current.id,
          action: "transit.catalog.cancel",
          request,
        });
        return canceled;
      } catch (error) {
        const rejected = failure(error);
        return reply.code(rejected.status).send({ error: rejected.error });
      }
    },
    { beforeValidation: limits.preHandler() },
  );
  register(app, "getAdminTransitPinExecution", async (request, reply) => {
    try {
      const current = dm.unwrapDataManagerResponse(
        await dm.getDataExecution(request.params.id, { transport: transport() }),
      );
      if (!["catalog.validate", "catalog.activate"].includes(current.kind))
        return reply.code(404).send({ error: "Catalog execution is unavailable" });
      return current;
    } catch (error) {
      const rejected = failure(error);
      return reply.code(rejected.status).send({ error: rejected.error });
    }
  });
}
