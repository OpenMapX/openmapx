import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privacyAdminRoute } from "../routes/privacy-admin.js";
import { createDbMock } from "../test/db.js";

const actor = vi.hoisted(() => ({ id: "reviewer", role: "admin" }));
vi.mock("../auth.js", () => ({
  auth: { api: { getSession: async () => ({ user: actor, session: { id: "session" } }) } },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  actor.id = "reviewer";
  actor.role = "admin";
});
const body = () => ({
  scope: "security-review",
  version: "fixture",
  decision: "approved",
  findingsDigest: null,
  reviewedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

async function requestApproval(payload = body()) {
  const database = createDbMock();
  database.queueInsert([{ id: "approval" }]);
  const app = Fastify();
  await app.register(privacyAdminRoute, {
    database: database.db as never,
    releaseEvidenceVersion: async () => "fixture",
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/privacy/admin/approvals",
      headers: { "idempotency-key": randomUUID() },
      payload,
    });
    return { response, database };
  } finally {
    await app.close();
  }
}

async function requestReadiness() {
  const database = createDbMock();
  database.queueSelect([]);
  const app = Fastify();
  await app.register(privacyAdminRoute, {
    database: database.db as never,
    releaseEvidenceVersion: async () => "fixture",
    operationsHealth: async () => ({
      monitorHealthy: true,
      cleanupHealthy: true,
      notificationHealthy: true,
      keyReady: true,
      storageHealthy: true,
      backupCapability: true,
      lastRunAt: new Date().toISOString(),
      lastErrorCode: null,
    }),
    managedDawarichAvailable: true,
    releaseContractChecks: {
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    },
  });
  try {
    return await app.inject({ method: "GET", url: "/privacy/admin/readiness" });
  } finally {
    await app.close();
  }
}

describe("privacy release approval routes", () => {
  it("does not accept a deployment ID as evidence of an independent implementation owner", async () => {
    vi.stubEnv("PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS", "");
    vi.stubEnv("OPENMAPX_DEPLOYMENT_ID", "deployment");
    const { response, database } = await requestApproval();
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("IMPLEMENTATION_OWNERS_NOT_CONFIGURED");
    expect(database.db.insert).not.toHaveBeenCalled();
  });
  it("rejects approval by an implementation owner", async () => {
    vi.stubEnv("PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS", "reviewer,second-owner");
    const { response, database } = await requestApproval();
    expect(response.statusCode).toBe(400);
    expect(database.db.insert).not.toHaveBeenCalled();
  });
  it("records an independent full administrator's approval", async () => {
    vi.stubEnv("PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS", "implementer");
    const { response, database } = await requestApproval();
    expect(response.statusCode).toBe(201);
    expect(database.db.insert).toHaveBeenCalledOnce();
  });
  it("rejects an approval for anything except the current derived evidence", async () => {
    vi.stubEnv("PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS", "implementer");
    const { response, database } = await requestApproval({ ...body(), version: "older-evidence" });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("EVIDENCE_VERSION_MISMATCH");
    expect(database.db.insert).not.toHaveBeenCalled();
  });
  it("does not grant approval authority to a privacy-only administrator", async () => {
    vi.stubEnv("PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS", "implementer");
    actor.role = "privacy_admin";
    const { response, database } = await requestApproval();
    expect(response.statusCode).toBe(403);
    expect(database.db.insert).not.toHaveBeenCalled();
  });

  it("reports verified implementation capabilities independently from missing human approvals", async () => {
    vi.stubEnv("PRIVACY_EXPORT_IMPLEMENTATION_ACTOR_IDS", "implementer");
    vi.stubEnv("PRIVACY_ARTIFACT_BACKUP_DISABLED", "true");
    const response = await requestReadiness();
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.evidenceVersion).toBe("fixture");
    expect(
      report.checks
        .filter((check: { status: string }) => check.status === "fail")
        .map((check: { id: string }) => check.id),
    ).toEqual(["approval-legal-content", "approval-dsar-process", "approval-security-review"]);
  });

  it("keeps new admin-triggered generation disabled when release readiness is closed", async () => {
    const database = createDbMock();
    database.queueSelect([]);
    const app = Fastify();
    await app.register(privacyAdminRoute, { database: database.db as never });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/privacy/admin/requests/${randomUUID()}/generate`,
        headers: { "idempotency-key": randomUUID() },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("PRIVACY_RELEASE_NOT_READY");
      expect(database.db.insert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
