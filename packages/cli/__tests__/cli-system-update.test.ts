import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, expect, it, vi } from "vitest";
import { releaseProvenance } from "../../core/src/services/__fixtures__/release-provenance";
import { runSystemUpdate } from "../src/lib/system-update";
import { SystemUpdateReceiptStore } from "../src/lib/system-update-receipt";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(mode = "success") {
  const root = mkdtempSync(join(tmpdir(), "openmapx-update-client-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = services.ensureReleaseStateDirectories(root);
  vi.stubEnv("OPENMAPX_RELEASE", "main");
  vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "must-never-be-sent");
  const manifest: services.ReleaseManifest = {
    schemaVersion: 1,
    release: "candidate",
    images: Object.fromEntries(
      services.RELEASE_IMAGE_NAMES.map((id) => [
        id,
        `ghcr.io/openmapx/${id}@sha256:${"a".repeat(64)}`,
      ]),
    ) as services.ReleaseManifest["images"],
    privacyReleaseValidation: {
      version: 1,
      sourceBuildFingerprint: "b".repeat(64),
      validatedAt: "2026-11-06T00:00:00.000Z",
      checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
    },
    ...releaseProvenance(),
  };
  const lock = await services.acquireReleaseStoreLock(paths.store, {}, { failIfBusy: true });
  const checked = services.cacheCheckedReleaseManifest({
    infraDir: root,
    manifest,
    ociDigest: `sha256:${"c".repeat(64)}`,
    configurationIdentity: services.releaseConfigurationIdentity(
      services.readAppliedReleaseSelection(root),
    ),
    lock,
  });
  lock.release();
  const sessionFile = join(root, "session");
  writeFileSync(sessionFile, "better-auth.session_token=synthetic.signed", { mode: 0o600 });
  const requests: Array<{
    method: string;
    url: string;
    key?: string;
    body: Record<string, unknown>;
    local?: string;
  }> = [];
  const backupId = randomUUID(),
    applyId = randomUUID();
  let origin = "",
    backupName = "",
    previewPosts = 0,
    applyPosts = 0,
    backupPosts = 0,
    polls = 0,
    finished = mode !== "timeout";
  let preview = services.buildPlatformConfigurationPreview({
    actorId: "admin",
    previewId: randomUUID(),
    authPolicyRevision: "d".repeat(64),
    sourceRevision: randomUUID(),
    currentRevisionId: null,
    expectedCurrentRevisionId: null,
    changes: { version: 1 },
    env: { DOMAIN: "maps.example.test", ACME_EMAIL: "admin@example.test" },
    services: [],
  });
  const detail = (id: string, type: string, result: unknown) => ({
    id,
    type,
    payload: {},
    error: null,
    progress: 100,
    createdBy: "admin",
    actorLabel: "Admin",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: new Date().toISOString(),
    cancelable: false,
    source: "application",
    status: "success",
    result,
    logs: [],
    stages: [],
  });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) : {};
    requests.push({
      method: req.method!,
      url: req.url!,
      key: req.headers["idempotency-key"] as string | undefined,
      body,
      local: req.headers["x-openmapx-local-admin"] as string | undefined,
    });
    res.setHeader("content-type", "application/json");
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/me")
      return send({
        user: {
          id: "admin",
          name: "Admin",
          email: "admin@example.test",
          emailVerified: true,
          image: null,
          role: mode === "nonadmin" ? "privacy_admin" : "admin",
        },
        session: { expiresAt: new Date(Date.now() + 3600000).toISOString() },
      });
    if (req.url?.startsWith("/api/admin/jobs?")) {
      if (mode === "active") {
        const {
          result: _result,
          logs: _logs,
          stages: _stages,
          ...summary
        } = detail(randomUUID(), "service.bulk", null);
        return send({ jobs: [{ ...summary, actor: null, status: "running" }], total: 1 });
      }
      return send({ jobs: [], total: 0 });
    }
    if (req.url === "/api/admin/platform/configuration")
      return send({
        expectedCurrentRevisionId: null,
        configuration: preview.configuration,
        values: preview.values,
        sources: preview.sources,
        pending: [],
      });
    if (req.method === "POST" && req.url === "/api/admin/services/backups") {
      backupPosts++;
      backupName = body.name;
      if (mode === "forbidden") return send({ error: "denied" }, 403);
      if (mode === "replay" && backupPosts === 1) return send({ error: "unknown" }, 503);
      return send({ ok: true, jobId: backupId });
    }
    if (req.url?.startsWith(`/api/admin/jobs/${backupId}`))
      return send(
        detail(backupId, "backup.operation", {
          backupId: mode === "wrong-backup" ? "different" : backupName,
        }),
      );
    if (req.url === "/api/admin/platform/configuration/preview") {
      previewPosts++;
      if (mode === "renew-session" && previewPosts === 1)
        return send({ error: "session expired" }, 401);
      preview = {
        ...preview,
        release: checked,
        affectedServiceIds: [
          "app-api",
          "app-web",
          "data-manager",
          "ops-agent",
          "transitous-runner",
        ],
        oldOrigin: origin,
        newOrigin: origin,
      };
      if (mode === "wrong-origin")
        preview = { ...preview, newOrigin: "https://other.example.test" };
      if (mode === "changed")
        preview = {
          ...preview,
          configuration: { version: 1, backupRetentionDays: { source: "database", value: 14 } },
        };
      return send({
        preview,
        expiresAt: new Date(Date.now() + (mode === "expired" ? 1000 : 600000)).toISOString(),
      });
    }
    if (req.url === "/api/admin/platform/configuration/apply") {
      applyPosts++;
      if (mode === "lost-apply" && applyPosts === 1) return send({ error: "unknown" }, 503);
      return send({ ok: true, jobId: applyId }, 202);
    }
    if (req.url?.startsWith(`/api/admin/jobs/${applyId}`)) {
      polls++;
      if (mode === "restart" && polls < 3) return send({ error: "restarting" }, 503);
      const job = detail(applyId, "platform.apply", {
        configuration: {
          outcome: "committed",
          revisionId: `cfg1_${"a".repeat(43)}`,
          enabledServiceIds: [
            "app-api",
            "app-web",
            "data-manager",
            "ops-agent",
            "transitous-runner",
          ],
          followUp: "complete",
          cleanupFailed: false,
          publisherCleanupFailed: mode === "incomplete",
          registryUpdateFailed: false,
        },
      });
      if (!finished) Object.assign(job, { status: "running", result: null, finishedAt: null });
      return send(job);
    }
    return send({ error: "unexpected" }, 400);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    options: {
      infraDir: root,
      apiOrigin: origin,
      allowLoopbackHttp: true,
      sessionFile,
      receipt: join(root, "update.json"),
      releaseId: checked.releaseId,
      manifestDigest: checked.manifestDigest,
      pollMs: 2,
      timeoutMs: mode === "timeout" ? 2000 : 10000,
    },
    requests,
    counts: () => ({ backupPosts, previewPosts, applyPosts }),
    finish() {
      finished = true;
    },
  };
}
it("backs up then reviews and applies the exact checked release without local-admin authority", async () => {
  const f = await fixture();
  await runSystemUpdate(f.options);
  expect(f.counts()).toEqual({ backupPosts: 1, previewPosts: 1, applyPosts: 1 });
  expect(f.requests.every((r) => r.local === undefined)).toBe(true);
  expect(f.requests.filter((r) => r.method === "POST").map((r) => r.url)).toEqual([
    "/api/admin/services/backups",
    "/api/admin/platform/configuration/preview",
    "/api/admin/platform/configuration/apply",
  ]);
  expect(f.requests.find((r) => r.url.endsWith("/preview"))?.body.changes).toEqual({ version: 1 });
});
it("skips all backup requests only when explicitly requested", async () => {
  const f = await fixture();
  await runSystemUpdate({ ...f.options, createBackup: false });
  expect(f.counts()).toEqual({ backupPosts: 0, previewPosts: 1, applyPosts: 1 });
  const receipt = new SystemUpdateReceiptStore(f.options.receipt).read();
  expect(receipt.createBackup).toBe(false);
  expect(receipt.steps.backup.body).toBeNull();
});
it.each([true, false])(
  "keeps the original backup choice on resume (backup=%s)",
  async (createBackup) => {
    const f = await fixture();
    await runSystemUpdate({ ...f.options, createBackup });
    const before = f.counts();
    await expect(
      runSystemUpdate({ ...f.options, resume: true, createBackup: !createBackup }),
    ).rejects.toThrow(/backup choice/);
    expect(f.counts()).toEqual(before);
    await runSystemUpdate({ ...f.options, resume: true, createBackup });
    expect(f.counts()).toEqual(before);
  },
);
it("still refuses active maintenance when the backup is skipped", async () => {
  const f = await fixture("active");
  await expect(runSystemUpdate({ ...f.options, createBackup: false })).rejects.toThrow();
  expect(f.counts()).toEqual({ backupPosts: 0, previewPosts: 0, applyPosts: 0 });
});
it.each(["active", "nonadmin", "forbidden", "wrong-backup", "changed", "wrong-origin", "expired"])(
  "stops safely on %s before apply",
  async (mode) => {
    const f = await fixture(mode);
    await expect(runSystemUpdate(f.options)).rejects.toThrow();
    expect(f.counts().applyPosts).toBe(0);
    if (mode === "forbidden") {
      expect(f.counts().backupPosts).toBe(1);
      expect(new SystemUpdateReceiptStore(f.options.receipt).read().steps.backup.finalStatus).toBe(
        403,
      );
      await expect(runSystemUpdate({ ...f.options, resume: true })).rejects.toThrow();
      expect(f.counts().backupPosts).toBe(1);
    }
  },
);
it("replays only an unknown POST with the same frozen key and body", async () => {
  const f = await fixture("replay");
  await runSystemUpdate(f.options);
  const posts = f.requests.filter((r) => r.url === "/api/admin/services/backups");
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
});
it("observes the original job through API restarts", async () => {
  const f = await fixture("restart");
  await runSystemUpdate(f.options);
  expect(f.counts().applyPosts).toBe(1);
});
it("resumes an observation timeout without making another backup, preview or apply", async () => {
  const f = await fixture("timeout");
  await expect(runSystemUpdate(f.options)).rejects.toThrow(/resume|timed out/i);
  const before = f.counts();
  expect(before).toEqual({ backupPosts: 1, previewPosts: 1, applyPosts: 1 });
  f.finish();
  await runSystemUpdate({ ...f.options, resume: true, timeoutMs: 10000 });
  expect(f.counts()).toEqual(before);
});
it("refuses local release transaction evidence before the first POST", async () => {
  const f = await fixture();
  writeFileSync(
    join(services.releaseStatePaths(f.options.infraDir).store, "transaction.json"),
    "{}",
    { mode: 0o600 },
  );
  await expect(runSystemUpdate(f.options)).rejects.toThrow();
  expect(f.requests.every((r) => r.method !== "POST")).toBe(true);
});

it("replays an unknown apply acceptance with its original key and exact reviewed body", async () => {
  const f = await fixture("lost-apply");
  await runSystemUpdate(f.options);
  const posts = f.requests.filter((r) => r.url.endsWith("/apply"));
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(f.counts().backupPosts).toBe(1);
});
it("does not claim success for a committed update with incomplete cleanup", async () => {
  const f = await fixture("incomplete");
  await expect(runSystemUpdate(f.options)).rejects.toThrow(/not confirmed complete/);
  expect(f.counts().applyPosts).toBe(1);
});

it("refreshes an expired session and resumes the same preview without another backup", async () => {
  const f = await fixture("renew-session");
  await expect(runSystemUpdate(f.options)).rejects.toThrow(/refresh.*session.*resume/i);
  expect(
    new SystemUpdateReceiptStore(f.options.receipt).read().steps.preview.finalStatus,
  ).toBeUndefined();
  writeFileSync(f.options.sessionFile, "better-auth.session_token=synthetic.fresh", {
    mode: 0o600,
  });
  await runSystemUpdate({ ...f.options, resume: true });
  const posts = f.requests.filter((r) => r.url.endsWith("/preview"));
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(f.counts().backupPosts).toBe(1);
});
