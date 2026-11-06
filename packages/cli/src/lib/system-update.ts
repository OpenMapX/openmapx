/** Drives the existing real-admin producer. No host mutation or new principal. */
import {
  adminActivityJobDetailSchema,
  adminActivityJobsResponseSchema,
  adminPlatformApplyInputSchema,
  adminPlatformConfigurationSchema,
  adminPlatformPreviewInputSchema,
  adminPlatformPreviewRetainedSchema,
  adminServiceAcceptedSchema,
  HOST_MUTATING_JOB_TYPES,
  publicSessionSchema,
} from "@openmapx/core/api-contracts";
import {
  completeTrustedConfigurationApply,
  parseTrustedConfigurationApplyOutcome,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import z from "zod/v4";
import { adminApiOrigin, readAdminSessionFile } from "./admin-session";
import {
  type SystemUpdateReceipt,
  SystemUpdateReceiptStore,
  type UpdateStep,
} from "./system-update-receipt";

class HttpFailure extends Error {
  constructor(readonly status: number) {
    super(`Administrative API returned HTTP ${status}`);
  }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const targets = ["app-api", "app-web", "data-manager", "ops-agent", "transitous-runner"];
export interface SystemUpdateOptions {
  infraDir: string;
  apiOrigin?: string;
  sessionFile: string;
  receipt: string;
  releaseId: string;
  manifestDigest: string;
  resume?: boolean;
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
  pollMs?: number;
}
export async function runSystemUpdate(options: SystemUpdateOptions): Promise<{ jobId: string }> {
  const origin = adminApiOrigin(options.apiOrigin, process.env.DOMAIN, options.allowLoopbackHttp);
  const cookie = readAdminSessionFile(options.sessionFile);
  const store = new SystemUpdateReceiptStore(options.receipt);
  const deadline = Date.now() + Math.min(options.timeoutMs ?? 60 * 60_000, 60 * 60_000);
  const poll = Math.max(1, Math.min(options.pollMs ?? 2000, 5000));
  const available = () => {
    if (Date.now() >= deadline)
      throw Error(
        "Update observation timed out; resume with the same receipt to inspect the original operation",
      );
  };
  const pause = async () => {
    available();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(poll, Math.max(1, deadline - Date.now()))),
    );
    available();
  };
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
  ): Promise<unknown> {
    available();
    const response = await fetch(`${origin}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now()))),
      headers: {
        cookie,
        origin,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpFailure(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("Administrative API response unavailable");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 1024 * 1024) throw Error("Administrative API response limit exceeded");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  }
  const transient = (error: unknown) =>
    !(error instanceof HttpFailure) || error.status === 429 || error.status >= 500;
  async function get<T>(path: string, schema: { parse(value: unknown): T }): Promise<T> {
    for (;;) {
      let data: unknown;
      try {
        data = await request(path);
      } catch (error) {
        if (!transient(error)) throw error;
        await pause();
        continue;
      }
      return schema.parse(data);
    }
  }
  const actor = await get("/api/me", publicSessionSchema);
  if (actor.user.role !== "admin" || Date.parse(actor.session.expiresAt) < Date.now() + 120000)
    throw Error("A full administrator session with at least two minutes remaining is required");
  const selection = services.readAppliedReleaseSelection(options.infraDir);
  if (selection.kind === "local") throw new services.ReleaseChannelDisabledError();
  const identity = {
    origin,
    actorId: actor.user.id,
    release: { releaseId: options.releaseId, manifestDigest: options.manifestDigest },
    configuredSelector: selection.selector,
    configurationIdentity: services.releaseConfigurationIdentity(options.infraDir),
  };
  let receipt: SystemUpdateReceipt;
  if (options.resume) {
    receipt = store.read();
    for (const key of [
      "origin",
      "actorId",
      "release",
      "configuredSelector",
      "configurationIdentity",
    ] as const)
      if (!equal(receipt[key], identity[key]))
        throw Error(
          "Receipt actor, origin, release or configured selection changed; do not reuse it",
        );
  } else {
    services.readCheckedConfigurationRelease(options.infraDir, identity.release);
    receipt = await store.create(identity);
  }
  async function guard() {
    services.readCheckedConfigurationRelease(options.infraDir, identity.release);
    if (services.releaseConfigurationIdentity(options.infraDir) !== identity.configurationIdentity)
      throw Error("Configured release selection changed");
    const configuration = await get(
      "/api/admin/platform/configuration",
      adminPlatformConfigurationSchema,
    );
    if (configuration.pending.length)
      throw Error("A platform configuration job is pending; inspect Activity");
    const active = await get(
      "/api/admin/jobs?status=active&limit=200&offset=0",
      adminActivityJobsResponseSchema,
    );
    if (
      active.total > active.jobs.length ||
      active.jobs.some((job) => (HOST_MUTATING_JOB_TYPES as readonly string[]).includes(job.type))
    )
      throw Error("Another host maintenance job is active; inspect Activity");
    return configuration;
  }
  async function post<T>(
    step: UpdateStep,
    path: string,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    for (;;) {
      receipt = store.read();
      const saved = receipt.steps[step];
      if (saved.response !== undefined) return schema.parse(saved.response);
      if (saved.finalStatus !== undefined) throw new HttpFailure(saved.finalStatus);
      if (saved.body === null) throw Error("Request was not retained before sending");
      let data: unknown;
      try {
        data = await request(path, "POST", saved.body, saved.key);
      } catch (error) {
        if (
          error instanceof HttpFailure &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        ) {
          await store.change((value) => {
            if (value.steps[step].response === undefined)
              value.steps[step].finalStatus = error.status;
          });
          throw error;
        }
        await pause();
        continue;
      }
      // A successful response which cannot be decoded is an unknown POST outcome.
      // Preserve its original key/body for an explicit resume, never make a new intent.
      const parsed = schema.parse(data);
      await store.change((value) => {
        if (value.steps[step].response !== undefined && !equal(value.steps[step].response, parsed))
          throw Error("Original request returned a different identity");
        value.steps[step].response = z.json().parse(parsed);
        delete value.steps[step].finalStatus;
      });
      return parsed;
    }
  }
  async function observe(id: string, type: string) {
    for (;;) {
      const job = await get(
        `/api/admin/jobs/${encodeURIComponent(id)}?source=application`,
        adminActivityJobDetailSchema,
      );
      if (
        job.source !== "application" ||
        job.id !== id ||
        job.type !== type ||
        job.createdBy !== identity.actorId
      )
        throw Error("Administrative job identity changed");
      if (job.status === "success") return job;
      if (["failed", "canceled"].includes(job.status))
        throw Error(
          "Original administrative job failed; inspect Activity before starting another update",
        );
      await pause();
    }
  }
  if (receipt.steps.backup.body === null) {
    await guard();
  }
  await store.freeze("backup", { name: receipt.backupName });
  const backup = await post("backup", "/api/admin/services/backups", adminServiceAcceptedSchema);
  const backupJob = await observe(backup.jobId, "backup.operation");
  if (
    !backupJob.result ||
    typeof backupJob.result !== "object" ||
    Array.isArray(backupJob.result) ||
    backupJob.result.backupId !== receipt.backupName
  )
    throw Error("Backup completion did not identify the requested backup");
  receipt = store.read();
  if (receipt.steps.preview.body === null) {
    const baseline = await guard();
    await store.change((value) => {
      value.baseline = baseline;
    });
    await store.freeze(
      "preview",
      adminPlatformPreviewInputSchema.parse({
        expectedCurrentRevisionId: baseline.expectedCurrentRevisionId,
        changes: { version: 1 },
        release: identity.release,
      }),
    );
  }
  receipt = store.read();
  if (!receipt.baseline) throw Error("Preview baseline unavailable");
  await store.freeze(
    "preview",
    adminPlatformPreviewInputSchema.parse({
      expectedCurrentRevisionId: receipt.baseline.expectedCurrentRevisionId,
      changes: { version: 1 },
      release: identity.release,
    }),
  );
  const reviewed = await post(
    "preview",
    "/api/admin/platform/configuration/preview",
    adminPlatformPreviewRetainedSchema,
  );
  receipt = store.read();
  const preview = reviewed.preview,
    baseline = receipt.baseline;
  if (
    !baseline ||
    preview.actorId !== identity.actorId ||
    preview.expectedCurrentRevisionId !== baseline.expectedCurrentRevisionId ||
    !equal(preview.configuration, baseline.configuration) ||
    !equal(preview.values, baseline.values) ||
    !equal(preview.sources, baseline.sources) ||
    preview.values.releaseSelector !== identity.configuredSelector ||
    preview.oldOrigin !== origin ||
    preview.newOrigin !== origin ||
    !equal(preview.release, identity.release) ||
    preview.reconcileServiceIds !== undefined ||
    !equal([...preview.affectedServiceIds].sort(), targets) ||
    Object.values(preview.requiredConfirmation).some(Boolean)
  )
    throw Error(
      "Reviewed update would change more than the exact checked release; apply was not sent",
    );
  if (receipt.steps.apply.body === null) {
    if (Date.parse(reviewed.expiresAt) < Date.now() + 30000)
      throw Error("Preview expired or too close to expiry; use a new receipt and backup");
    const fresh = await guard();
    if (!equal(fresh, baseline))
      throw Error("Platform configuration changed after preview; apply was not sent");
    await store.freeze(
      "apply",
      adminPlatformApplyInputSchema.parse({
        expectedCurrentRevisionId: preview.expectedCurrentRevisionId,
        previewFingerprint: preview.previewFingerprint,
        confirmations: preview.requiredConfirmation,
      }),
    );
  }
  await store.freeze(
    "apply",
    adminPlatformApplyInputSchema.parse({
      expectedCurrentRevisionId: preview.expectedCurrentRevisionId,
      previewFingerprint: preview.previewFingerprint,
      confirmations: preview.requiredConfirmation,
    }),
  );
  const applied = await post(
    "apply",
    "/api/admin/platform/configuration/apply",
    adminServiceAcceptedSchema,
  );
  const job = await observe(applied.jobId, "platform.apply");
  if (
    !job.result ||
    typeof job.result !== "object" ||
    Array.isArray(job.result) ||
    !completeTrustedConfigurationApply(
      parseTrustedConfigurationApplyOutcome(job.result.configuration),
    )
  )
    throw Error("Configuration outcome requires inspection; update is not confirmed complete");
  return { jobId: job.id };
}
