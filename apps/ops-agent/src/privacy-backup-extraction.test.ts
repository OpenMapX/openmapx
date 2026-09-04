import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  createPrivacyBackupCapability,
  privacyBackupSubjectLocatorDigest,
} from "@openmapx/core/ops";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPrivacyBackupExtractionRoute } from "./privacy-backup-extraction";

const token = "api-token";
const capabilityKey = randomBytes(32);
const fixed = new Date("2026-09-04T10:00:00.000Z");
const requestIds = () => ({ requestId: randomUUID(), taskId: randomUUID() });

async function makeApp() {
  const app = Fastify({ logger: false });
  registerPrivacyBackupExtractionRoute(app, {
    apiToken: token,
    capabilityKey,
    now: () => fixed,
    inspectBackup: async (request) => ({
      backupId: request.backupId,
      manifestDigest: request.manifestDigest,
      platformVersion: "1.0.0",
      formatVersion: 2,
      verified: true,
    }),
    runCollector: async () => Readable.from([Buffer.from("tar-data")]),
  });
  await app.ready();
  return app;
}

async function body() {
  const ids = requestIds();
  const base = {
    ...ids,
    backupId: "backup-1",
    manifestDigest: "a".repeat(64),
    cutoff: "2026-09-04T09:00:00.000Z",
    collectorContract: "openmapx-subject-export-v1" as const,
    subjectLocator: { kind: "user_id" as const, value: "user-1" },
    subjectLocatorDigest: privacyBackupSubjectLocatorDigest({ kind: "user_id", value: "user-1" }),
  };
  return {
    version: 1 as const,
    ...base,
    capability: createPrivacyBackupCapability(base, capabilityKey, fixed),
  };
}

describe("privacy backup extraction endpoint", () => {
  it("requires the API token and streams only the fixed media type", async () => {
    const app = await makeApp();
    const input = await body();
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/privacy/backup-subject-export",
      payload: input,
    });
    expect(unauthorized.statusCode).toBe(401);
    const response = await app.inject({
      method: "POST",
      url: "/v1/privacy/backup-subject-export",
      headers: { authorization: `Bearer ${token}` },
      payload: input,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/vnd.openmapx.privacy-backup-subject-tar.v1",
    );
    expect(response.body).toBe("tar-data");
  });

  it("consumes a capability once and rejects a changed binding", async () => {
    const app = await makeApp();
    const input = await body();
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/privacy/backup-subject-export",
          headers,
          payload: input,
        })
      ).statusCode,
    ).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/privacy/backup-subject-export",
      headers,
      payload: input,
    });
    expect(replay.statusCode).toBe(409);
    const changed = await body();
    const tampered = { ...changed, capability: input.capability };
    const mismatch = await app.inject({
      method: "POST",
      url: "/v1/privacy/backup-subject-export",
      headers,
      payload: tampered,
    });
    expect(mismatch.statusCode).toBe(409);
  });

  it("does not consume a capability while another extraction is active", async () => {
    let started!: () => void;
    let release!: () => void;
    const extractionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const extractionRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = Fastify({ logger: false });
    registerPrivacyBackupExtractionRoute(app, {
      apiToken: token,
      capabilityKey,
      now: () => fixed,
      inspectBackup: async (request) => ({
        backupId: request.backupId,
        manifestDigest: request.manifestDigest,
        platformVersion: "1.0.0",
        formatVersion: 2,
        verified: true,
      }),
      runCollector: async () => {
        started();
        await extractionRelease;
        return Readable.from([Buffer.from("tar-data")]);
      },
    });
    await app.ready();
    const input = await body();
    const headers = { authorization: `Bearer ${token}` };
    const first = app.inject({
      method: "POST",
      url: "/v1/privacy/backup-subject-export",
      headers,
      payload: input,
    });
    await extractionStarted;
    const busy = await app.inject({
      method: "POST",
      url: "/v1/privacy/backup-subject-export",
      headers,
      payload: input,
    });
    expect(busy.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/privacy/backup-subject-export",
      headers,
      payload: input,
    });
    expect(replay.statusCode).toBe(409);
  });
});
