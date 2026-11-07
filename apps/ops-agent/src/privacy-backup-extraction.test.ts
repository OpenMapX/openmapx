import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  createPrivacyBackupCapability,
  privacyBackupSubjectLocatorDigest,
} from "@openmapx/core/ops";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerPrivacyBackupExtractionRoute } from "./privacy-backup-extraction";

const token = "api-token";
const capabilityKey = randomBytes(32);
const fixed = new Date("2026-09-04T10:00:00.000Z");
const requestIds = () => ({ requestId: randomUUID(), taskId: randomUUID() });

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function makeApp(runCollector = async () => Readable.from([Buffer.from("tar-data")])) {
  const app = Fastify({ logger: false });
  apps.push(app);
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
    runCollector,
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
    expect(replay.json().error).toBe("capability_replayed");
    const changed = await body();
    const tampered = { ...changed, taskId: randomUUID() };
    const mismatch = await app.inject({
      method: "POST",
      url: "/v1/privacy/backup-subject-export",
      headers,
      payload: tampered,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toBe("capability_invalid");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/privacy/backup-subject-export",
          headers,
          payload: changed,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("does not consume a fresh capability while another extraction is active", async () => {
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const app = await makeApp(async () => {
      started.resolve();
      await released.promise;
      return Readable.from([Buffer.from("tar-data")]);
    });
    const input = await body();
    const waiting = await body();
    const headers = { authorization: `Bearer ${token}` };
    const first = app.inject({
      method: "POST",
      url: "/v1/privacy/backup-subject-export",
      headers,
      payload: input,
    });
    try {
      await started.promise;
      const pendingBusy = app.inject({
        method: "POST",
        url: "/v1/privacy/backup-subject-export",
        headers,
        payload: waiting,
      });
      const deadline = Promise.withResolvers<never>();
      const timer = setTimeout(
        () => deadline.reject(new Error("Busy request waited for the running extraction")),
        2_000,
      );
      let busy: Awaited<typeof pendingBusy>;
      try {
        busy = await Promise.race([pendingBusy, deadline.promise]);
      } finally {
        clearTimeout(timer);
      }
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error).toBe("busy");
      released.resolve();
      expect((await first).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/privacy/backup-subject-export",
            headers,
            payload: waiting,
          })
        ).statusCode,
      ).toBe(200);
      const replay = await app.inject({
        method: "POST",
        url: "/v1/privacy/backup-subject-export",
        headers,
        payload: waiting,
      });
      expect(replay.statusCode).toBe(409);
      expect(replay.json().error).toBe("capability_replayed");
    } finally {
      released.resolve();
      await first;
    }
  });
});
