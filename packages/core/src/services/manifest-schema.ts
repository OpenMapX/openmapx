import z from "zod/v4";
import { type CapabilityWarning, collectCapabilityWarnings } from "./capabilities";
import type { ServiceManifest } from "./types";

const IMAGE_REGEX = /^[a-z0-9]([a-z0-9._\-/])*$/;
const TAG_REGEX = /^[a-zA-Z0-9._-]+$/;
// Docker's container-name grammar: `[a-zA-Z0-9][a-zA-Z0-9_.-]*` (single-char
// names are legal, hence `*` not `+` after the leading char).
const CONTAINER_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
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

// `@infra:<rel-path>` resolves against `infra/docker/`, the compose-file
// directory. Built-in only; used by data-manager to share `infra/docker/data/`
// with consumer services that bind the same base via their `consumes:` mount.
export const INFRA_BIND_SOURCE_PREFIX = "@infra:";
const INFRA_BIND_SOURCE_REGEX = /^@infra:[^\s]+$/;

export function isInfraBindSource(s: string): boolean {
  return INFRA_BIND_SOURCE_REGEX.test(s);
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

// Capabilities that community and community-verified services may request.
// Excludes all capabilities that can trivially escape a container or affect
// the host kernel/devices: SYS_ADMIN, SYS_PTRACE, SYS_TIME, SYS_CHROOT,
// NET_ADMIN, MKNOD, DAC_READ_SEARCH, IPC_LOCK, AUDIT_WRITE.
// SYS_ADMIN must never appear here — it is a well-known container-escape primitive.
export const COMMUNITY_SAFE_CAPS = new Set([
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
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

// Instance ids end up in on-disk hardlink target paths (data/<consumer-id>/
// <type>/<instance>/) so they share the same slug shape as service ids.
const INSTANCE_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const TARGET_FILENAME_REGEX = /^[a-zA-Z0-9._-]+$/;

const consumesSchema = z.object({
  type: z.string().min(1),
  instance: z.string().regex(INSTANCE_ID_REGEX, "must be lowercase, hyphen-separated").optional(),
  mountAt: z
    .string()
    .regex(ABSOLUTE_PATH_REGEX, "must be absolute")
    .refine((p) => !pathHasParentEscape(p), "must not contain '..'"),
  targetFilename: z
    .string()
    .regex(TARGET_FILENAME_REGEX, "must be a filename, not a path")
    .refine((name) => name !== "." && name !== "..", "must be a filename, not a path")
    .optional(),
  readOnly: z.boolean().optional(),
  required: z.boolean().optional(),
});

const producesSchema = z.object({
  type: z.string().min(1),
  instance: z.string().regex(INSTANCE_ID_REGEX, "must be lowercase, hyphen-separated").optional(),
  sourceDir: z.string().min(1),
});

// Matches a fully-substituted Docker Compose variable reference:
// `${VAR}`, `${VAR:-default}`, `${VAR:?error message}`, or `$VAR`. Bind mount
// sources/targets that use this form are passed through to the Compose parser
// at stack-up time — app-api uses this for its host-path-agreeing mount pair
// so the operator can set OPENMAPX_HOST_DIR in `.env` without re-rendering
// the manifest. The `:?…` error-on-unset form is allowed to contain spaces
// inside the braces so operators get a readable message instead of a cryptic
// compose error.
const COMPOSE_VAR_SOURCE_REGEX = /^\$(\{[^{}]+\}|[A-Za-z_][A-Za-z0-9_]*)/;

const bindMountSchema = z
  .object({
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
        if (isInfraBindSource(s)) {
          const path = s.slice(INFRA_BIND_SOURCE_PREFIX.length);
          if (!path || path.startsWith("/")) return false;
          return !pathHasParentEscape(path);
        }
        if (COMPOSE_VAR_SOURCE_REGEX.test(s)) {
          // Compose-variable pass-through — rendered verbatim, no '..'/traversal
          // analysis possible because the path is resolved at stack-up time.
          return !pathHasParentEscape(s);
        }
        if (s.startsWith("@")) return false; // unknown special source
        if (s.startsWith("/")) return false; // absolute paths forbidden
        if (pathHasParentEscape(s)) return false;
        return true;
        // biome-ignore lint/suspicious/noTemplateCurlyInString: error message documents literal compose-substitution syntax (${VAR}, ${VAR:-default}), not JS template placeholders
      }, "source must be a relative path (no '..', no absolute paths), a known special source (@docker-socket, @service:<slug>:<rel-path>, @infra:<rel-path>), or a Compose-variable reference (${VAR}, ${VAR:-default})"),
    target: z
      .string()
      .min(1)
      .refine((p) => {
        // Compose-variable reference at the start → pass-through. Even so we
        // forbid `..` anywhere in the string so a malicious default can't
        // traverse out of the container root.
        if (COMPOSE_VAR_SOURCE_REGEX.test(p)) return !pathHasParentEscape(p);
        if (!ABSOLUTE_PATH_REGEX.test(p)) return false;
        return !pathHasParentEscape(p);
      }, "must be absolute or a Compose-variable reference, and must not contain '..'"),
    readOnly: z.boolean().optional(),
    // Optional bind mounts are silently dropped from the rendered compose when
    // the host-side source file/directory is absent at render time. Used for
    // operator-supplied secrets (e.g. an age private key for Transitous): the
    // manifest declares the contract once, but the mount only materialises
    // after the operator drops the file at the documented path. Without this,
    // docker-compose would create the missing source as an empty host
    // directory and shadow `/secrets/<file>` inside the container.
    //
    // Limitations: the renderer can only check existence for sources that
    // resolve to a concrete host path at render time. `$VAR`-prefixed sources
    // are substituted by docker-compose at stack-up time, so `optional` on
    // those is rejected here — there's no host path to stat.
    optional: z.boolean().optional(),
  })
  .refine(
    (bm) => !(bm.optional && COMPOSE_VAR_SOURCE_REGEX.test(bm.source)),
    "optional: true is not supported with Compose-variable sources — the host path is unknown until stack-up time",
  );

const dependsOnSchema = z.object({
  service: z.string(),
  condition: z.enum(["service_started", "service_healthy"]).optional(),
});

const containerSchema = z.object({
  image: z.string().regex(IMAGE_REGEX, "must be lowercase, no tag suffix (use 'tag' field)"),
  tag: z.string().regex(TAG_REGEX),
  containerName: z
    .string()
    .regex(CONTAINER_NAME_REGEX, "must be a valid docker container name")
    .optional(),
  expose: z.array(z.number().int().min(1).max(65535)).optional(),
  networkAliases: z
    .array(
      z.string().regex(/^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/, "must be a valid DNS label"),
    )
    .optional(),
  command: z.union([z.array(z.string()), z.string()]).optional(),
  entrypoint: z.union([z.array(z.string()), z.string()]).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  envFile: z
    .array(
      z
        .string()
        .min(1)
        .refine((s) => !pathHasParentEscape(s), "must not contain '..'")
        .refine((s) => !s.startsWith("/"), "must be a relative path under infra/docker/"),
    )
    .optional(),
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
  gpu: z
    .object({
      driver: z.string().default("nvidia"),
      count: z.union([z.number().int().positive(), z.literal("all")]).default("all"),
      capabilities: z.array(z.string()).default(["gpu"]),
    })
    .optional(),
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

// Capability declaration — accepts either a bare string (the common case)
// or `{ capability, metadata? }`. The `metadata` slot is reserved for future
// runtime layers (region routing, per-mode capability selection, etc.); the
// platform doesn't read it today.
const providesEntrySchema = z.union([
  z.string().min(1),
  z.object({
    capability: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
]);

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

  provides: z.array(providesEntrySchema).optional(),
  consumes: z.array(consumesSchema).optional(),
  produces: z.array(producesSchema).optional(),

  configSchema: z.record(z.string(), z.unknown()).optional(),
  envVars: z.array(envVarSchema).optional(),

  // Postgres schema this service owns and migrates itself, idempotently, on boot
  // (CREATE SCHEMA/TABLE IF NOT EXISTS under its own DB role). Declaration only —
  // the platform applies no migration and grants nothing.
  ownsSchema: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, "must be a valid lowercase Postgres identifier")
    .optional(),

  volumes: z.array(volumeSchema).optional(),
  bindMounts: z.array(bindMountSchema).optional(),
  exposure: exposureSchema.optional(),

  buildCommand: z.string().optional(),

  ui: uiSchema.optional(),
});

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
  /**
   * Non-blocking advisories — currently used for capability/data-type strings
   * that are neither well-known nor properly namespaced (`<vendor>/<name>`).
   * Operators see these in the admin UI and the `pnpm openmapx services
   * capabilities` output; the manifest still loads.
   */
  warnings?: CapabilityWarning[];
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

  if (m.quality !== "built-in" && m.container.networkMode === "host") {
    errors.push("container.networkMode: 'host' is not allowed for community services");
  }
  if (m.quality !== "built-in" && m.container.privileged) {
    errors.push("container.privileged is not allowed for community services");
  }
  if (m.quality !== "built-in") {
    for (const cap of m.container.capAdd ?? []) {
      if (!COMMUNITY_SAFE_CAPS.has(cap)) {
        errors.push(`container.capAdd: '${cap}' is not allowed for community services`);
      }
    }
    if (m.container.devices?.length) {
      errors.push("container.devices are not allowed for community services");
    }
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

  // A service can ship multiple `produces` entries for the same `type` only
  // when each carries a distinct `instance` id. Same (type, instance) pair
  // twice is always a mistake — it'd give two source dirs for the same
  // logical dataset. The default-instance entry counts as `instance: undefined`
  // and may appear at most once per type.
  const seenProduces = new Set<string>();
  for (const p of m.produces ?? []) {
    const key = `${p.type}\u0000${p.instance ?? ""}`;
    if (seenProduces.has(key)) {
      errors.push(
        p.instance
          ? `produces: duplicate (type "${p.type}", instance "${p.instance}") — each producer instance must be unique`
          : `produces: duplicate default-instance entry for type "${p.type}" — declare distinct \`instance\` ids when shipping multiple instances`,
      );
    }
    seenProduces.add(key);
  }

  // Capability + data-type advisories. Non-blocking; surface these to the
  // operator so community plugins migrate toward namespaced names without
  // breaking existing manifests.
  const warnings = collectCapabilityWarnings(m);

  return {
    valid: errors.length === 0,
    errors,
    ...(warnings.length ? { warnings } : {}),
  };
}
