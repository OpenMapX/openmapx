import z from "zod/v4";
import type { ServiceManifest } from "./types";

const IMAGE_REGEX = /^[a-z0-9]([a-z0-9._\-/])*$/;
const TAG_REGEX = /^[a-zA-Z0-9._-]+$/;
const VOLUME_NAME_REGEX = /^openmapx-[a-z0-9-]+$/;
const ABSOLUTE_PATH_REGEX = /^\/[^\s]+$/;
const PATH_PREFIX_REGEX = /^\/[a-zA-Z0-9._\-/]*$/;

// Built-in services may request a bind mount from one of these special host
// sources. Community services are rejected by post-parse validation and cannot
// use them. Keep this list tight — each entry is a security boundary.
export const SPECIAL_BIND_SOURCES = new Set<string>(["@docker-socket"]);

// `@service:<slug>:<rel-path>` is a parameterized special source: built-in
// services may mount a file from another built-in service's directory. Useful
// for shared config (e.g. pelias-placeholder + pelias-pip mount pelias's
// `config/pelias.json` without duplicating it). The renderer enforces that
// `<rel-path>` doesn't traverse out of the named service's directory.
export const SERVICE_BIND_SOURCE_PREFIX = "@service:";
const SERVICE_BIND_SOURCE_REGEX = /^@service:[a-z0-9][a-z0-9-]*:[^\s]+$/;

export function isServiceBindSource(s: string): boolean {
  return SERVICE_BIND_SOURCE_REGEX.test(s);
}

// Linux capabilities allowed for declaration. Restricted to a known set so
// community services can't smuggle arbitrary strings into docker compose.
const ALLOWED_CAPS = new Set([
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "DAC_READ_SEARCH",
  "FOWNER",
  "FSETID",
  "IPC_LOCK",
  "KILL",
  "MKNOD",
  "NET_ADMIN",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
  "SYS_ADMIN",
  "SYS_CHROOT",
  "SYS_PTRACE",
  "SYS_TIME",
]);

function pathHasParentEscape(path: string): boolean {
  return path.split("/").includes("..");
}

const healthcheckSchema = z.object({
  type: z.enum(["http", "tcp", "exec"]),
  path: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  command: z.union([z.array(z.string()), z.string()]).optional(),
  interval: z.string().optional(),
  timeout: z.string().optional(),
  retries: z.number().int().min(0).optional(),
  startPeriod: z.string().optional(),
});

const portMappingSchema = z.object({
  container: z.number().int().min(1).max(65535),
  host: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]).optional(),
  bindAddress: z.string().optional(),
});

const additionalRouteSchema = z
  .object({
    pathPrefix: z.string().regex(PATH_PREFIX_REGEX).optional(),
    path: z.string().regex(PATH_PREFIX_REGEX).optional(),
    middleware: z.array(z.string()).optional(),
  })
  .refine(
    (v) => Boolean(v.pathPrefix) !== Boolean(v.path),
    "exactly one of 'pathPrefix' or 'path' must be set on each additional route",
  );

const proxyExposureSchema = z.object({
  enabled: z.boolean(),
  pathPrefix: z.string().regex(PATH_PREFIX_REGEX).optional(),
  stripPrefix: z.boolean().optional(),
  middleware: z.array(z.string()).optional(),
  authRequired: z.boolean().optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  additionalRoutes: z.array(additionalRouteSchema).optional(),
});

const exposureSchema = z.object({
  hostPorts: z.array(portMappingSchema).optional(),
  proxy: proxyExposureSchema.optional(),
});

const volumeSchema = z.object({
  name: z.string().regex(VOLUME_NAME_REGEX, "must start with 'openmapx-'"),
  mountAt: z
    .string()
    .regex(ABSOLUTE_PATH_REGEX, "must be absolute")
    .refine((p) => !pathHasParentEscape(p), "must not contain '..'"),
  readOnly: z.boolean().optional(),
  backup: z.boolean().optional(),
});

const consumesSchema = z.object({
  type: z.string().min(1),
  mountAt: z
    .string()
    .regex(ABSOLUTE_PATH_REGEX, "must be absolute")
    .refine((p) => !pathHasParentEscape(p), "must not contain '..'"),
  readOnly: z.boolean().optional(),
  required: z.boolean().optional(),
});

const producesSchema = z.object({
  type: z.string().min(1),
  sourceDir: z.string().min(1),
});

const bindMountSchema = z.object({
  source: z
    .string()
    .min(1)
    .refine((s) => {
      if (SPECIAL_BIND_SOURCES.has(s)) return true;
      if (isServiceBindSource(s)) {
        // Validate the embedded path part doesn't try to escape the named service.
        const path = s.slice(SERVICE_BIND_SOURCE_PREFIX.length).split(":").slice(1).join(":");
        if (!path || path.startsWith("/")) return false;
        return !pathHasParentEscape(path);
      }
      if (s.startsWith("@")) return false; // unknown special source
      if (s.startsWith("/")) return false; // absolute paths forbidden
      if (pathHasParentEscape(s)) return false;
      return true;
    }, "source must be a relative path (no '..', no absolute paths) or a known special source (@docker-socket, @service:<slug>:<rel-path>)"),
  target: z
    .string()
    .regex(ABSOLUTE_PATH_REGEX, "must be absolute")
    .refine((p) => !pathHasParentEscape(p), "must not contain '..'"),
  readOnly: z.boolean().optional(),
});

const dependsOnSchema = z.object({
  service: z.string(),
  condition: z.enum(["service_started", "service_healthy"]).optional(),
});

const containerSchema = z.object({
  image: z.string().regex(IMAGE_REGEX, "must be lowercase, no tag suffix (use 'tag' field)"),
  tag: z.string().regex(TAG_REGEX),
  expose: z.array(z.number().int().min(1).max(65535)).optional(),
  command: z.union([z.array(z.string()), z.string()]).optional(),
  entrypoint: z.union([z.array(z.string()), z.string()]).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  workingDir: z.string().optional(),
  user: z.string().optional(),
  shmSize: z.string().optional(),
  capAdd: z
    .array(z.string())
    .refine(
      (caps) => caps.every((c) => ALLOWED_CAPS.has(c)),
      "capAdd entries must be a known Linux capability (uppercase, e.g. NET_ADMIN)",
    )
    .optional(),
  capDrop: z
    .array(z.string())
    .refine((caps) => caps.every((c) => ALLOWED_CAPS.has(c) || c === "ALL"), "unknown capability")
    .optional(),
  devices: z.array(z.string().regex(/^\/dev\/[a-zA-Z0-9_\-/]+$/)).optional(),
  privileged: z.boolean().optional(),
  networkMode: z.enum(["bridge", "host"]).optional(),
  memory: z.string().optional(),
  restart: z.enum(["no", "on-failure", "always", "unless-stopped"]).optional(),
  healthcheck: healthcheckSchema.optional(),
  dependsOn: z.array(dependsOnSchema).optional(),
  logging: z
    .object({ driver: z.string(), options: z.record(z.string(), z.string()).optional() })
    .optional(),
});

const envVarSchema = z.object({
  name: z.string(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  default: z.string().optional(),
});

const uiSchema = z.object({
  icon: z.string().optional(),
  category: z.string().optional(),
});

export const serviceManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase, hyphen-separated"),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  homepage: z.string().url().optional(),
  documentation: z.string().url().optional(),
  quality: z.enum(["built-in", "community-verified", "community"]),
  platform: z.string().optional(),

  container: containerSchema,

  provides: z.array(z.string()).optional(),
  consumes: z.array(consumesSchema).optional(),
  produces: z.array(producesSchema).optional(),

  configSchema: z.record(z.string(), z.unknown()).optional(),
  envVars: z.array(envVarSchema).optional(),

  volumes: z.array(volumeSchema).optional(),
  bindMounts: z.array(bindMountSchema).optional(),
  exposure: exposureSchema.optional(),

  buildCommand: z.string().optional(),

  ui: uiSchema.optional(),
});

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateServiceManifest(raw: unknown): ManifestValidationResult {
  const result = serviceManifestSchema.safeParse(raw);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const m = result.data as ServiceManifest;
  const errors: string[] = [];

  if (m.quality === "community" && m.container.networkMode === "host") {
    errors.push("container.networkMode: 'host' is not allowed for community services");
  }
  if (m.quality === "community" && m.container.privileged) {
    errors.push("container.privileged is not allowed for community services");
  }
  if (m.exposure?.proxy?.enabled && !m.container.expose?.length) {
    errors.push(
      "exposure.proxy.enabled requires container.expose to declare at least one port for the proxy to route to",
    );
  }
  // Community and community-verified services may bind-mount their OWN config
  // files (relative paths under the service directory, already constrained by
  // the bindMount source regex). They CANNOT use `@`-prefixed special sources
  // (docker socket, etc.) — those grant host-level access and are built-in only.
  if (m.quality !== "built-in") {
    for (const bm of m.bindMounts ?? []) {
      if (bm.source.startsWith("@")) {
        errors.push(
          `bindMounts: special source "${bm.source}" is only allowed for built-in services`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
