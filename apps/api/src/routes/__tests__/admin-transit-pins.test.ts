/** BFF/generated-SDK transport/auth proof. DM HTTP is an I/O fixture, not a signed host authority. */
import { createHash, randomUUID } from "node:crypto";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { createCatalogPinSet } from "@openmapx/core/catalog-pins";
import {
  type DataExecutionStatus,
  normalizeDataExecutionInput,
  startDataExecutionSchema,
} from "@openmapx/core/data-manager-contracts";
import {
  canonicalJson,
  createControlRootOperationKey,
  executionFingerprint,
} from "@openmapx/core/ops";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockAdminSession } from "../../test/auth";

const state = vi.hoisted(() => ({ session: null as unknown, audit: vi.fn() }));
vi.mock("../../auth", () => ({ auth: { api: { getSession: async () => state.session } } }));
vi.mock("../../utils/audit-log", () => ({ writeAuditLog: state.audit }));

import { adminTransitPinsRoute } from "../admin-transit-pins";

let app: FastifyInstance,
  backend: FastifyInstance,
  client: ReturnType<typeof createApiClient>,
  posts = 0,
  loseNext = false;
const rows = new Map<string, DataExecutionStatus>(),
  proposals = new Map<string, { branch: string; proposal: ReturnType<typeof proposal> }>();
function proposal(id: string, branch: string) {
  const lockedAt = new Date().toISOString(),
    pins = createCatalogPinSet(
      {
        ref: `${branch}@${"a".repeat(40)}`,
        submodules: { "transitland-atlas": "b".repeat(40) },
        lockedAt,
        lockedBy: "fixture",
      },
      {
        schemaVersion: 1,
        source: "mobilitydata-gbfs",
        commit: "c".repeat(40),
        url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"c".repeat(40)}/systems.csv`,
        sha256: "d".repeat(64),
        lockedAt,
        lockedBy: "fixture",
      },
    );
  return {
    proposalId: id,
    baseGenerationId: null,
    pins,
    diffDigest: "e".repeat(64),
    sourcePolicyRevision: "f".repeat(64),
    state: "proposed" as const,
    createdAt: lockedAt,
  };
}
const key = () =>
  createControlRootOperationKey({
    notAfter: Date.now() + 120000,
    nonce: crypto.getRandomValues(new Uint8Array(16)),
  });
beforeEach(async () => {
  vi.stubEnv("OPENMAPX_DISABLE_LOCALHOST_AUTH", "1");
  vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "component-service-token");
  state.session = mockAdminSession();
  state.audit.mockReset();
  rows.clear();
  proposals.clear();
  posts = 0;
  loseNext = false;
  backend = Fastify({ forceCloseConnections: true });
  backend.addHook("preHandler", async (request, reply) => {
    if (request.headers.authorization !== "Bearer component-service-token")
      return reply.code(401).send({ error: "authentication" });
  });
  backend.get<{ Params: { operationKey: string } }>(
    "/executions/by-key/:operationKey",
    async (request, reply) =>
      rows.get(request.params.operationKey) ?? reply.code(404).send({ error: "unknown" }),
  );
  backend.get<{ Params: { id: string } }>(
    "/executions/:id",
    async (request, reply) =>
      [...rows.values()].find((row) => row.id === request.params.id) ??
      reply.code(404).send({ error: "unknown" }),
  );
  backend.post("/executions", async (request, reply) => {
    posts++;
    const body = startDataExecutionSchema.parse(request.body),
      input = normalizeDataExecutionInput(body.input),
      deadlineAt = body.requestedDeadlineAt!;
    const row: DataExecutionStatus = {
      id: randomUUID(),
      kind: input.kind,
      operationKey: body.operationKey,
      fingerprint: executionFingerprint({
        kind: input.kind,
        operationFingerprint: createHash("sha256").update(canonicalJson(input)).digest("hex"),
        deadlineAt,
      }),
      admittedAt: Date.now(),
      deadlineAt,
      status: "queued",
      progress: null,
      diagnostics: { tail: [], truncated: false },
      publication: "not_started",
      cancellationRequestedAt: null,
    };
    rows.set(row.operationKey, row);
    if (loseNext) {
      loseNext = false;
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    return reply.code(202).send(row);
  });
  backend.post<{ Params: { id: string } }>("/executions/:id/cancel", async (request, reply) => {
    const row = [...rows.values()].find((value) => value.id === request.params.id);
    if (!row) return reply.code(404).send({ error: "unknown" });
    const canceled = {
      ...row,
      status: "cancel_pending" as const,
      cancellationRequestedAt: new Date().toISOString(),
    };
    rows.set(row.operationKey, canceled);
    return canceled;
  });
  backend.get<{ Querystring: { proposalId?: string } }>("/transit/pins", async (request) => ({
    active: null,
    catalogRevisionId: null,
    allowedCountries: ["de"],
    page: { proposals: [], total: 0, offset: 0, nextOffset: null },
    proposal: request.query.proposalId
      ? (proposals.get(request.query.proposalId)?.proposal ?? null)
      : null,
    diff: null,
    validation: null,
    execution: null,
    validationInputs: null,
    validationEligible: false,
    blocker: null,
  }));
  backend.post<{ Body: { proposalId: string; branch: string } }>(
    "/transit/bump",
    async (request) => {
      posts++;
      const selected = proposal(request.body.proposalId, request.body.branch);
      proposals.set(selected.proposalId, { branch: request.body.branch, proposal: selected });
      return {
        ok: true,
        unchanged: false,
        proposed: true,
        proposalId: selected.proposalId,
        catalogRevisionId: selected.pins.generationId,
        ref: selected.pins.transitous.ref,
        previousRef: null,
        submoduleSha: "b".repeat(40),
        lockedAt: selected.createdAt,
        lockedBy: "fixture",
      };
    },
  );
  vi.stubEnv("DATA_MANAGER_URL", await backend.listen({ host: "127.0.0.1", port: 0 }));
  app = Fastify({ forceCloseConnections: true });
  await app.register(adminTransitPinsRoute, { prefix: "/api" });
  client = createApiClient({ baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }) });
});
afterEach(async () => {
  await app?.close();
  await backend?.close();
  vi.unstubAllEnvs();
});
it("uses the real generated SDK and reuses the exact admitted job instead of submitting it twice", async () => {
  const proposalId = randomUUID(),
    headers = { "idempotency-key": key() };
  const first = await sdk.validateAdminTransitPins(
    proposalId,
    { countries: ["DE", "de"] },
    headers,
    { client },
  );
  expect(first.status).toBe(202);
  expect(
    sdk.unwrapAdminResponse(
      await sdk.validateAdminTransitPins(proposalId, { countries: ["DE", "de"] }, headers, {
        client,
      }),
    ),
  ).toEqual(sdk.unwrapAdminResponse(first));
  expect(posts).toBe(1);
  expect(
    (await sdk.validateAdminTransitPins(proposalId, { countries: ["at"] }, headers, { client }))
      .status,
  ).toBe(409);
  expect(posts).toBe(1);
});
it("recovers a lost admission response by lookup only and cancels that exact identity", async () => {
  loseNext = true;
  const accepted = sdk.unwrapAdminResponse(
    await sdk.validateAdminTransitPins(
      randomUUID(),
      { countries: ["de"] },
      { "idempotency-key": key() },
      { client },
    ),
  );
  expect(posts).toBe(1);
  const row = [...rows.values()][0]!;
  expect(accepted.jobId).toBe(row.id);
  const canceled = sdk.unwrapAdminResponse(
    await sdk.cancelAdminTransitPinExecution(
      row.id,
      { operationKey: row.operationKey, fingerprint: row.fingerprint },
      { client },
    ),
  );
  expect(canceled.status).toBe("cancel_pending");
  expect(posts).toBe(1);
});
it("retains proposal identity and refuses a changed branch on the same key", async () => {
  const headers = { "idempotency-key": key() },
    first = sdk.unwrapAdminResponse(
      await sdk.proposeAdminTransitPins({ branch: "main" }, headers, { client }),
    );
  expect(
    sdk.unwrapAdminResponse(
      await sdk.proposeAdminTransitPins({ branch: "main" }, headers, { client }),
    ),
  ).toEqual(first);
  expect(posts).toBe(1);
  expect(
    (await sdk.proposeAdminTransitPins({ branch: "different" }, headers, { client })).status,
  ).toBe(409);
  expect(posts).toBe(1);
});
it("keeps authentication/role/header denial ahead of the DM side effect", async () => {
  state.session = null;
  expect((await sdk.getAdminTransitPins(undefined, { client })).status).toBe(401);
  state.session = { ...mockAdminSession(), user: { ...mockAdminSession().user, role: "user" } };
  expect((await sdk.getAdminTransitPins(undefined, { client })).status).toBe(403);
  state.session = mockAdminSession();
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/transit/pins/proposals/${randomUUID()}/validate`,
    payload: { countries: ["de"] },
  });
  expect(response.statusCode).toBe(400);
  expect(posts).toBe(0);
});
