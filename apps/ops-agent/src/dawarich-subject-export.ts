import { type ChildProcess, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { type Readable, Transform } from "node:stream";
import {
  DAWARICH_SUPPORTED_COMMIT,
  DAWARICH_SUPPORTED_IMAGE,
  DAWARICH_SUPPORTED_IMAGE_DIGEST,
  DAWARICH_TAR_MEDIA_TYPE,
  type DawarichErrorCode,
  type DawarichSubjectRequestV1,
  dawarichSubjectRequestV1Schema,
} from "@openmapx/core/privacy";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { runContainedProcess } from "./docker-runtime";

const REQUEST_HEADER = /^ops1_[A-Za-z0-9_-]{16,64}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_REPLAY_ENTRIES = 1_024;

export interface DawarichRuntimeIdentity {
  image: string;
  digest: string;
  commit: string;
}

export interface DawarichSubjectExportRouteOptions {
  apiToken: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => number;
  inspectRuntime?: () => Promise<DawarichRuntimeIdentity>;
  runCollector?: (request: DawarichSubjectRequestV1, signal: AbortSignal) => Promise<Readable>;
}

export class DawarichSubjectExportRouteError extends Error {
  constructor(readonly code: DawarichErrorCode) {
    super(code);
  }
}

function authMatches(header: unknown, token: string): boolean {
  if (typeof header !== "string") return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match || token.length < 1) return false;
  const left = createHash("sha256").update(match[1]).digest();
  const right = createHash("sha256").update(token).digest();
  return timingSafeEqual(left, right);
}

function boundedRequestId(value: unknown): string | null {
  return typeof value === "string" && REQUEST_HEADER.test(value) ? value : null;
}

function publicError(
  reply: FastifyReply,
  requestId: string,
  code: DawarichErrorCode,
  status = 502,
): void {
  reply
    .code(status)
    .header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff")
    .send({ version: 1, requestId, error: code });
}

function runtimeSupported(identity: DawarichRuntimeIdentity): boolean {
  return (
    identity.image === DAWARICH_SUPPORTED_IMAGE &&
    identity.digest === DAWARICH_SUPPORTED_IMAGE_DIGEST &&
    identity.commit === DAWARICH_SUPPORTED_COMMIT
  );
}

/** Register the isolated, non-journaled Dawarich byte-stream endpoint. */
export function registerDawarichSubjectExportRoute(
  app: FastifyInstance,
  options: DawarichSubjectExportRouteOptions,
): void {
  const inFlight = { active: false };
  const seen = new Map<string, number>();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000)
    throw new Error("invalid Dawarich export timeout");
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_OUTPUT_BYTES
  )
    throw new Error("invalid Dawarich export output limit");
  app.post(
    "/v1/privacy/dawarich-subject-export",
    { bodyLimit: MAX_BODY_BYTES, logLevel: "silent" },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId =
        boundedRequestId(request.headers["x-ops-request-id"]) ?? "ops1_unavailable000000";
      if (!authMatches(request.headers.authorization, options.apiToken))
        return publicError(reply, requestId, "collector_failed", 401);
      if (options.enabled === false) return publicError(reply, requestId, "not_configured", 503);
      const parsed = dawarichSubjectRequestV1Schema.safeParse(request.body);
      if (!parsed.success) return publicError(reply, requestId, "schema_mismatch", 400);
      const nowMs = now();
      for (const [key, expiry] of seen) if (expiry <= nowMs) seen.delete(key);
      if (inFlight.active) return publicError(reply, requestId, "busy", 409);
      if (seen.has(parsed.data.requestId)) return publicError(reply, requestId, "busy", 409);
      if (seen.size >= MAX_REPLAY_ENTRIES) return publicError(reply, requestId, "busy", 409);
      seen.set(parsed.data.requestId, nowMs + 5 * 60_000);
      inFlight.active = true;
      const controller = new AbortController();
      let stream: Readable | undefined;
      let handedOff = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        // The deadline covers admission, runtime inspection, collector startup
        // and the complete response stream.  Starting it only after the child
        // is spawned would allow a stuck Docker/API call to run unbounded.
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          stream?.destroy(new DawarichSubjectExportRouteError("timeout"));
        }, timeoutMs);
        if (options.inspectRuntime) {
          const identity = await options.inspectRuntime();
          if (!runtimeSupported(identity))
            throw new DawarichSubjectExportRouteError("unsupported_version");
        }
        if (!options.runCollector) throw new DawarichSubjectExportRouteError("not_configured");
        stream = await options.runCollector(parsed.data, controller.signal);
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk: Buffer | Uint8Array, _encoding, callback) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxOutputBytes) {
              controller.abort();
              callback(new DawarichSubjectExportRouteError("limit_exceeded"));
              return;
            }
            callback(null, Buffer.from(chunk));
          },
        });
        stream.once("error", (error) => bounded.destroy(error));
        const abortOnClose = () => {
          if (!reply.raw.writableEnded) {
            controller.abort();
            stream?.destroy(new DawarichSubjectExportRouteError("timeout"));
          }
        };
        request.raw.once("close", abortOnClose);
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (timer !== undefined) clearTimeout(timer);
          request.raw.removeListener("close", abortOnClose);
          inFlight.active = false;
        };
        bounded.once("close", finish);
        stream.pipe(bounded);
        reply
          .header("Content-Type", DAWARICH_TAR_MEDIA_TYPE)
          .header("Cache-Control", "no-store")
          .header("X-Content-Type-Options", "nosniff")
          .header("Referrer-Policy", "no-referrer");
        handedOff = true;
        return reply.send(bounded);
      } catch (error) {
        const code =
          error instanceof DawarichSubjectExportRouteError
            ? error.code
            : timedOut || controller.signal.aborted
              ? "timeout"
              : "collector_failed";
        const status =
          code === "busy"
            ? 409
            : code === "not_configured"
              ? 503
              : code === "schema_mismatch"
                ? 400
                : 502;
        controller.abort();
        if (timer !== undefined) clearTimeout(timer);
        stream?.destroy();
        return publicError(reply, requestId, code, status);
      } finally {
        if (!handedOff) inFlight.active = false;
      }
    },
  );
}

export interface DockerDawarichCollectorOptions {
  containerName?: string;
  inspect?: () => Promise<DawarichRuntimeIdentity>;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

export interface DockerDawarichRuntimeInspectorOptions {
  /** The only container accepted by the production wiring. */
  containerName?: string;
  dockerBinary?: string;
  /** Injectable command runner for unit tests; production uses the contained
   * process helper so `docker inspect` cannot leave descendants behind. */
  run?: (
    file: string,
    args: readonly string[],
    options: { signal: AbortSignal; timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

function imageDigestFromInspection(value: Record<string, unknown>, image: string): string | null {
  const repoDigests = Array.isArray(value.RepoDigests) ? value.RepoDigests : [];
  const match = repoDigests.find(
    (entry) => typeof entry === "string" && entry.startsWith(`${image}@sha256:`),
  );
  if (typeof match === "string") return match.slice(image.length + 1);
  const configured =
    typeof value.Config === "object" && value.Config !== null
      ? (value.Config as Record<string, unknown>).Image
      : undefined;
  if (typeof configured === "string") {
    const at = configured.indexOf("@sha256:");
    if (at >= 0) return configured.slice(at + 1);
  }
  return null;
}

function labelOrEnv(value: Record<string, unknown>, key: string): string | null {
  const config =
    typeof value.Config === "object" && value.Config !== null
      ? (value.Config as Record<string, unknown>)
      : {};
  const labels =
    typeof config.Labels === "object" && config.Labels !== null
      ? (config.Labels as Record<string, unknown>)
      : {};
  if (typeof labels[key] === "string") return labels[key];
  const env = Array.isArray(config.Env) ? config.Env : [];
  const prefix = `${key}=`;
  const entry = env.find(
    (candidate) => typeof candidate === "string" && candidate.startsWith(prefix),
  );
  return typeof entry === "string" ? entry.slice(prefix.length) : null;
}

/** Inspect only the trusted managed container and return the compatibility
 * tuple required by the fixed collector route.  The JSON output is bounded and
 * never includes environment values in errors or logs. */
export function createDockerDawarichRuntimeInspector(
  options: DockerDawarichRuntimeInspectorOptions = {},
): () => Promise<DawarichRuntimeIdentity> {
  const containerName = options.containerName ?? "dawarich-app";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(containerName))
    throw new Error("invalid Dawarich container name");
  const run = options.run ?? runContainedProcess;
  return async () => {
    const result = await run(
      options.dockerBinary ?? "docker",
      ["inspect", "--type", "container", "--format", "{{json .}}", containerName],
      {
        signal: AbortSignal.timeout(15_000),
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
    );
    let inspection: Record<string, unknown>;
    try {
      inspection = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    } catch {
      throw new DawarichSubjectExportRouteError("collector_failed");
    }
    // A malformed response is rejected rather than attempting to recover an
    // image from free text.
    if (!inspection || typeof inspection !== "object")
      throw new DawarichSubjectExportRouteError("collector_failed");
    const config =
      typeof inspection.Config === "object" && inspection.Config !== null
        ? (inspection.Config as Record<string, unknown>)
        : {};
    const image = typeof config.Image === "string" ? config.Image : "";
    const inspected = { ...inspection, Config: config };
    const digest = imageDigestFromInspection(inspected, DAWARICH_SUPPORTED_IMAGE.split(":", 1)[0]);
    const commit =
      labelOrEnv(inspected, "OPENMAPX_DAWARICH_COMMIT") ??
      labelOrEnv(inspected, "org.opencontainers.image.revision");
    if (!image || !digest || !commit) throw new DawarichSubjectExportRouteError("collector_failed");
    const imageWithoutDigest = image.includes("@") ? image.split("@", 1)[0] : image;
    const normalizedImage =
      imageWithoutDigest === DAWARICH_SUPPORTED_IMAGE.split(":", 1)[0] &&
      digest === DAWARICH_SUPPORTED_IMAGE_DIGEST
        ? DAWARICH_SUPPORTED_IMAGE
        : imageWithoutDigest;
    return { image: normalizedImage, digest, commit };
  };
}

/** Fixed Docker invocation used by production wiring. The subject request is
 * sent only on stdin; no locator is ever present in argv, env or a path. */
export function createDockerDawarichCollector(
  options: DockerDawarichCollectorOptions = {},
): (request: DawarichSubjectRequestV1, signal: AbortSignal) => Promise<Readable> {
  const container = options.containerName ?? "dawarich-app";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(container)) throw new Error("invalid Dawarich container name");
  const spawnProcess = options.spawnImpl ?? spawn;
  return async (request, signal) => {
    if (options.inspect) {
      const identity = await options.inspect();
      if (!runtimeSupported(identity))
        throw new DawarichSubjectExportRouteError("unsupported_version");
    }
    const child: ChildProcess = spawnProcess(
      "docker",
      [
        "exec",
        "--interactive",
        container,
        "bundle",
        "exec",
        "ruby",
        "/opt/openmapx/subject-export/openmapx-subject-export.rb",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let childClosed = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const clearForceKillTimer = () => {
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
    };
    const terminate = () => {
      if (childClosed || child.exitCode != null) return;
      if (!child.killed) child.kill("SIGTERM");
      if (forceKillTimer === undefined) {
        forceKillTimer = setTimeout(() => {
          forceKillTimer = undefined;
          if (!childClosed && child.exitCode == null) child.kill("SIGKILL");
        }, 1_000);
      }
    };
    signal.addEventListener("abort", terminate, { once: true });
    const timer = setTimeout(terminate, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once("close", () => {
      childClosed = true;
      clearForceKillTimer();
      clearTimeout(timer);
      signal.removeEventListener("abort", terminate);
    });
    // Always drain stderr so a noisy collector cannot deadlock on a full pipe.
    // Its contents are intentionally discarded; only the bounded public error
    // code is allowed to leave this boundary.
    child.stderr?.resume();
    child.once("error", () => undefined);
    child.stdin?.end(`${JSON.stringify(request)}\n`);
    if (!child.stdout) {
      terminate();
      throw new DawarichSubjectExportRouteError("collector_failed");
    }
    return child.stdout as Readable;
  };
}
