import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import { detectConsumesCycle } from "./resolver";
import type {
  HardlinkEntry,
  LoadedService,
  RenderResult,
  ServiceBindMount,
  ServiceConsumes,
  ServiceManifest,
  ServiceProduces,
} from "./types";

/**
 * Producer index keyed by `<type>` for default/single-instance producers and
 * `<type>/<instance>` for instanced ones. Built once per render so consumer
 * lookups are O(1). See {@link resolveProducer}.
 */
type ProducerEntry = {
  producerId: string;
  produces: ServiceProduces;
};
type ProducerIndex = {
  /** type → entry, only set when the producer has no `instance` (the "default"). */
  default: Map<string, ProducerEntry>;
  /** `${type}/${instance}` → entry. */
  instanced: Map<string, ProducerEntry>;
  /** type → all entries (default + instanced) for fall-back lookup. */
  byType: Map<string, ProducerEntry[]>;
};

function buildProducerIndex(services: LoadedService[]): ProducerIndex {
  const index: ProducerIndex = {
    default: new Map(),
    instanced: new Map(),
    byType: new Map(),
  };
  for (const s of services) {
    for (const p of s.manifest.produces ?? []) {
      const entry: ProducerEntry = { producerId: s.manifest.id, produces: p };
      if (p.instance === undefined) {
        if (index.default.has(p.type)) {
          throw new Error(
            `Multiple default-instance producers for type "${p.type}": ${index.default.get(p.type)?.producerId} and ${s.manifest.id}. Disambiguate with distinct \`instance\` ids on the producers, then specify \`instance\` on consumers.`,
          );
        }
        index.default.set(p.type, entry);
      } else {
        const key = `${p.type}/${p.instance}`;
        if (index.instanced.has(key)) {
          throw new Error(
            `Multiple producers for (type "${p.type}", instance "${p.instance}"): ${index.instanced.get(key)?.producerId} and ${s.manifest.id}. Each (type, instance) pair must be unique across the registry.`,
          );
        }
        index.instanced.set(key, entry);
      }
      const list = index.byType.get(p.type) ?? [];
      list.push(entry);
      index.byType.set(p.type, list);
    }
  }
  return index;
}

function consumesKey(consumes: ServiceConsumes): string {
  return consumes.instance ? `${consumes.type}/${consumes.instance}` : consumes.type;
}

/**
 * Resolve a consumer entry to the producer that satisfies it, or `null` when
 * the entry is explicitly optional and no producer is found. Throws on missing
 * required producers and ambiguity.
 */
function resolveProducer(
  consumes: ServiceConsumes,
  consumerId: string,
  index: ProducerIndex,
): ProducerEntry | null {
  if (consumes.instance !== undefined) {
    const key = `${consumes.type}/${consumes.instance}`;
    const found = index.instanced.get(key);
    if (found) return found;
    if (consumes.required === false) return null;
    throw new Error(
      `Service "${consumerId}" consumes (type "${consumes.type}", instance "${consumes.instance}") but no producer with that instance is installed.`,
    );
  }

  const def = index.default.get(consumes.type);
  if (def) return def;

  // No default producer. If exactly one instanced producer exists for this
  // type, use it as the implicit default — the common single-instance case.
  const candidates = index.byType.get(consumes.type) ?? [];
  if (candidates.length === 1) return candidates[0] ?? null;

  if (candidates.length === 0) {
    if (consumes.required === false) return null;
    throw new Error(
      `Service "${consumerId}" consumes required data type "${consumes.type}" but no producer is installed.`,
    );
  }

  // Multiple producer instances and the consumer didn't pick one.
  throw new Error(
    `Service "${consumerId}" consumes type "${consumes.type}" without specifying an \`instance\`, but multiple producer instances are installed: ${candidates.map((c) => c.produces.instance ?? "<default>").join(", ")}. Add \`instance\` to disambiguate.`,
  );
}

/** Local hardlink target dir used by both consumer mount paths and the plan. */
function hardlinkTargetDir(consumerId: string, c: ServiceConsumes): string {
  const base = `data/${consumerId}/${c.type}`;
  return c.instance ? `${base}/${c.instance}` : base;
}

export interface RenderContext {
  domain?: string;
  /**
   * Per-consumer-entry mount paths keyed by the same `<type>` / `<type>/<instance>`
   * key shape used in the producer index. The renderer wires this up
   * automatically; callers don't usually pass it.
   */
  consumesPaths?: Map<string, string>;
  /**
   * Absolute directory the generated compose file will be written to. Used to
   * render bind-mount sources as paths relative to the compose file location
   * (how docker-compose resolves them). When absent, absolute paths are emitted.
   */
  composeOutDir?: string;
  /**
   * Full list of services in the registry. Required for resolving
   * `@service:<slug>:<path>` bind-mount sources (the renderer needs to know
   * the target service's directory). When absent, the consuming service is
   * treated as the only service available.
   */
  allServices?: LoadedService[];
  /**
   * Per-service admin/env-resolved configuration values, merged into the
   * rendered `container.environment` so operator-set values actually reach
   * the container. Caller (CLI or API) is responsible for computing the map
   * — the renderer is pure and does not read the DB or process.env itself.
   *
   * Precedence inside this map is the caller's concern. When merged into the
   * container env, these values override any matching key declared on the
   * manifest's `container.environment`, since operator config is expected to
   * win over manifest defaults. Values are stringified via `String(value)` at
   * merge time (docker-compose env values are strings).
   */
  resolvedServiceConfigs?: Map<string, Record<string, unknown>>;
  /**
   * Per-service list of secret config keys that currently have a vault value.
   * The renderer wires each as a Docker `secrets:` mount (source
   * `<serviceId>__<KEY>` → target `<KEY>`, mounted at `/run/secrets/<KEY>`) and
   * sets `<KEY>_FILE=/run/secrets/<KEY>` in the environment — the *path*, never
   * the value. The secret values themselves are written to
   * `<composeOutDir>/.generated-secrets/<serviceId>/<KEY>` by the caller
   * (app-api's render step), which holds the decryption key. The renderer stays
   * pure: it only needs the key names. The DB-free CLI reconstructs this map
   * from the previously generated compose (and, when readable, the
   * `.generated-secrets/` dir) so its renders preserve the vault mounts. May
   * contain services outside the rendered subset — their top-level `secrets:`
   * entries are carried forward so a narrowed render never erases the record.
   */
  serviceSecretKeys?: Map<string, string[]>;
  /**
   * Optional override for the host-path existence check used by
   * `bindMounts[].optional`. Defaults to `node:fs`'s `existsSync`. Tests
   * inject a fake here to avoid touching the real filesystem; production
   * callers should leave it unset.
   */
  existsSync?: (path: string) => boolean;
  /**
   * Per-render advisory sink. The renderer appends one entry per skipped
   * optional bind mount (host source missing). When omitted, advisories are
   * still emitted on the `RenderResult.warnings` field.
   */
  warnings?: string[];
  /**
   * Per-render sink for writable `@infra:data/...` bind-mount source dirs (as
   * absolute host paths). The deploy step pre-creates these as the invoking
   * (data-owning) user before `docker compose up`, so docker doesn't auto-create
   * them as root — which would leave a non-root container (and the data-manager
   * pipeline) unable to write into its own data dir. Surfaced on
   * `RenderResult.writableBindDirs` when omitted.
   */
  bindDirSink?: string[];
}

// Maps `@`-prefixed special bind sources (literals only) to concrete host
// paths. Parameterized special sources like `@service:<slug>:<path>` are
// handled separately in `resolveBindSource` because they need access to the
// other service's directory.
const SPECIAL_BIND_SOURCE_PATHS: Record<string, string> = {
  "@docker-socket": "/var/run/docker.sock",
};

const SERVICE_BIND_PREFIX = "@service:";
const INFRA_BIND_PREFIX = "@infra:";

function toComposePath(absolute: string, composeOutDir: string | undefined): string {
  if (!composeOutDir) return absolute;
  const rel = relative(composeOutDir, absolute);
  // Ensure docker-compose sees it as a path (not a volume name).
  if (!rel.startsWith(".") && !isAbsolute(rel)) return `./${rel}`;
  return rel;
}

/**
 * Resolved bind-mount source. `src` is the string written into compose
 * (compose-relative path or pass-through `$VAR`); `absoluteHostPath` is the
 * concrete host path when known, used to back the `optional` existence check.
 * `null` for `$VAR` sources because the path is resolved by docker-compose at
 * stack-up time and is therefore unknown to the renderer.
 */
interface ResolvedBindSource {
  src: string;
  absoluteHostPath: string | null;
}

function resolveBindSource(
  bm: ServiceBindMount,
  service: LoadedService,
  allServices: LoadedService[],
  composeOutDir: string | undefined,
): ResolvedBindSource {
  // Compose-variable pass-through. Sources that start with `$` — including
  // `${VAR}`, `${VAR:-default}`, and `$VAR` — are emitted verbatim so the
  // Docker Compose parser does the substitution at stack-up time. This is
  // how app-api opts into a "host path = container path" bind mount for
  // Docker-outside-of-Docker admin control without having to bake the
  // operator's host path into the manifest.
  if (bm.source.startsWith("$")) {
    return { src: bm.source, absoluteHostPath: null };
  }
  // Literal special sources (e.g. @docker-socket) — emit the concrete path.
  if (SPECIAL_BIND_SOURCE_PATHS[bm.source]) {
    const concrete = SPECIAL_BIND_SOURCE_PATHS[bm.source];
    return { src: concrete, absoluteHostPath: concrete };
  }

  // @infra:<rel-path> — mount from the compose-file directory (infra/docker/).
  // Used by data-manager so its /data is the same host directory that
  // consumer services bind via their `consumes` mounts.
  if (bm.source.startsWith(INFRA_BIND_PREFIX)) {
    const relPath = bm.source.slice(INFRA_BIND_PREFIX.length);
    if (!composeOutDir) {
      // No compose dir known — emit the relative path unchanged so downstream
      // callers can still introspect the source.
      return { src: `./${relPath}`, absoluteHostPath: null };
    }
    const absolute = resolve(composeOutDir, relPath);
    return { src: toComposePath(absolute, composeOutDir), absoluteHostPath: absolute };
  }

  // @service:<slug>:<rel-path> — mount from another built-in service's directory.
  if (bm.source.startsWith(SERVICE_BIND_PREFIX)) {
    const rest = bm.source.slice(SERVICE_BIND_PREFIX.length);
    const colonIdx = rest.indexOf(":");
    if (colonIdx < 0) {
      throw new Error(
        `bindMount source "${bm.source}" on service "${service.manifest.id}": missing ':<rel-path>' after slug`,
      );
    }
    const slug = rest.slice(0, colonIdx);
    const relPath = rest.slice(colonIdx + 1);
    const target = allServices.find((s) => s.manifest.id === slug);
    if (!target) {
      throw new Error(
        `bindMount source "${bm.source}" on service "${service.manifest.id}": service "${slug}" not found in registry`,
      );
    }
    if (target.manifest.quality !== "built-in") {
      throw new Error(
        `bindMount source "${bm.source}" on service "${service.manifest.id}": @service:<slug> is only allowed to reference built-in services (target "${slug}" is "${target.manifest.quality}")`,
      );
    }
    const absolute = resolve(target.directory, relPath);
    return { src: toComposePath(absolute, composeOutDir), absoluteHostPath: absolute };
  }

  // Plain relative path — resolved against the consuming service's own dir.
  const absolute = resolve(service.directory, bm.source);
  return { src: toComposePath(absolute, composeOutDir), absoluteHostPath: absolute };
}

export interface ComposeServiceSnippet {
  image: string;
  container_name?: string;
  expose?: string[];
  ports?: string[];
  command?: string[] | string;
  entrypoint?: string[] | string;
  environment?: Record<string, string>;
  env_file?: string[];
  working_dir?: string;
  user?: string;
  group_add?: string[];
  shm_size?: string;
  cap_add?: string[];
  cap_drop?: string[];
  devices?: string[];
  privileged?: boolean;
  network_mode?: string;
  networks?: string[] | Record<string, { aliases?: string[] }>;
  volumes?: string[];
  secrets?: Array<{ source: string; target: string }>;
  labels?: Record<string, string>;
  restart?: string;
  healthcheck?: Record<string, unknown>;
  depends_on?: Record<string, { condition: string }>;
  logging?: { driver: string; options?: Record<string, string> };
  deploy?: {
    resources?: {
      limits?: { memory?: string };
      reservations?: {
        devices?: Array<{ driver: string; count: number | "all"; capabilities: string[] }>;
      };
    };
  };
}

/** Top-level Docker secret name for a service's vault key (namespaced per service). */
export function serviceSecretName(serviceId: string, key: string): string {
  return `${serviceId}__${key}`;
}

/**
 * Compose `file:` source for a service secret, relative to the compose-file
 * directory. The app-api render step writes the decrypted value to this exact
 * path so the rendered `secrets:` block and the on-disk files never drift.
 */
export function serviceSecretFilePath(serviceId: string, key: string): string {
  return `./${GENERATED_SECRETS_DIRNAME}/${serviceId}/${key}`;
}

/**
 * Directory (under the compose-file directory) where the app-api render step
 * materialises the decrypted per-service secret files.
 */
export const GENERATED_SECRETS_DIRNAME = ".generated-secrets";

/**
 * Reconstruct the per-service vault secret KEY names from an EXISTING generated
 * compose file's top-level `secrets:` block (each entry named
 * `<serviceId>__<KEY>` per {@link serviceSecretName}). The app-api render step
 * derives these from the DB (which holds the values + decryption key); the
 * DB-free CLI reads them back from the compose it last wrote, so a CLI re-render
 * preserves the same `secrets:` block + `<KEY>_FILE` env the admin render
 * produced instead of silently dropping it — both management surfaces converge
 * on an identical, applyable compose.
 *
 * Deliberately reads the compose (world-readable) rather than scanning
 * `.generated-secrets/`, which is created 0700 (root-only) as the real
 * host-side secret boundary and is unreadable by a non-root CLI. Only key names
 * are recovered — never values. Tolerant of a missing / secrets-less /
 * unparseable compose (returns an empty map), so it never crashes a render.
 */
export function readServiceSecretKeysFromCompose(composePath: string): Map<string, string[]> {
  const byService = new Map<string, string[]>();
  if (!existsSync(composePath)) return byService;
  let doc: { secrets?: Record<string, unknown> } | null;
  try {
    doc = yamlLoad(readFileSync(composePath, "utf8")) as {
      secrets?: Record<string, unknown>;
    } | null;
  } catch {
    return byService;
  }
  const secrets = doc?.secrets;
  if (!secrets || typeof secrets !== "object") return byService;
  for (const name of Object.keys(secrets)) {
    const sep = name.indexOf("__");
    if (sep <= 0) continue;
    const serviceId = name.slice(0, sep);
    const key = name.slice(sep + 2);
    const list = byService.get(serviceId) ?? [];
    list.push(key);
    byService.set(serviceId, list);
  }
  for (const [id, keys] of byService) byService.set(id, keys.sort());
  return byService;
}

/**
 * Best-effort reconstruction of per-service vault secret KEY names from the
 * materialised `.generated-secrets/<serviceId>/<KEY>` files themselves. This is
 * the same on-disk layout the app-api render step writes, so when the CLI runs
 * with enough privilege to list the (0700, root-owned) directory it recovers
 * the keys even when the previous compose is missing or was written without a
 * `secrets:` block. A non-root CLI gets EACCES on the readdir — swallowed, the
 * compose-derived keys remain the only source then. Only key names are read,
 * never file contents.
 */
export function readServiceSecretKeysFromDisk(composeOutDir: string): Map<string, string[]> {
  const byService = new Map<string, string[]>();
  const root = join(composeOutDir, GENERATED_SECRETS_DIRNAME);
  let serviceIds: string[];
  try {
    serviceIds = readdirSync(root);
  } catch {
    // Missing dir, or unreadable (0700 root-owned, non-root CLI) — both fine.
    return byService;
  }
  for (const serviceId of serviceIds) {
    let keys: string[];
    try {
      keys = readdirSync(join(root, serviceId));
    } catch {
      // Stray file or unreadable per-service dir — skip, never crash a render.
      continue;
    }
    if (keys.length > 0) byService.set(serviceId, [...keys].sort());
  }
  return byService;
}

/**
 * Union of per-service secret-key maps (deduplicated, sorted per service).
 * Used by the CLI to combine the compose-derived and disk-derived key sets so
 * a render never drops a key that either source still knows about.
 */
export function mergeServiceSecretKeys(
  ...sources: Array<Map<string, string[]>>
): Map<string, string[]> {
  const merged = new Map<string, Set<string>>();
  for (const source of sources) {
    for (const [serviceId, keys] of source) {
      const set = merged.get(serviceId) ?? new Set<string>();
      for (const key of keys) set.add(key);
      merged.set(serviceId, set);
    }
  }
  return new Map([...merged].map(([serviceId, set]) => [serviceId, [...set].sort()]));
}

export function renderServiceSnippet(
  service: LoadedService,
  ctx: RenderContext,
): ComposeServiceSnippet {
  const m = service.manifest;
  const c = m.container;
  const snippet: ComposeServiceSnippet = {
    image: `${c.image}:${c.tag}`,
  };

  // Pin the container name when the manifest opts in — see ServiceContainer.
  // containerName. Lets the data-manager address the container by bare name
  // over the docker CLI instead of the compose-derived `<project>-<svc>-<n>`.
  if (c.containerName) snippet.container_name = c.containerName;

  if (c.expose?.length) snippet.expose = c.expose.map((p) => String(p));

  if (m.exposure?.hostPorts?.length) {
    snippet.ports = m.exposure.hostPorts.map((p) => {
      const proto = p.protocol ? `/${p.protocol}` : "";
      const bind = p.bindAddress ? `${p.bindAddress}:` : "";
      return `${bind}${p.host}:${p.container}${proto}`;
    });
  }

  if (c.command !== undefined) snippet.command = c.command;
  if (c.entrypoint !== undefined) snippet.entrypoint = c.entrypoint;
  if (c.envFile?.length) snippet.env_file = [...c.envFile];
  if (c.environment) snippet.environment = { ...c.environment };
  // Overlay operator-resolved config onto the manifest's baseline environment.
  // Resolved values win over manifest defaults (that's the whole point of
  // admin/env config). Keys with `undefined`/`null` values are skipped so a
  // partial config map doesn't blank out manifest defaults.
  const resolved = ctx.resolvedServiceConfigs?.get(m.id);
  if (resolved) {
    const env = snippet.environment ?? {};
    for (const [key, value] of Object.entries(resolved)) {
      if (value === undefined || value === null) continue;
      env[key] = String(value);
    }
    if (Object.keys(env).length > 0) snippet.environment = env;
  }
  // Vault secrets (the container track): mount each as a Docker secret at
  // `/run/secrets/<KEY>` and point `<KEY>_FILE` at it. The value never enters
  // the environment (which is exposed via `docker inspect`/`/proc/environ`);
  // the consumer reads the file. Source name is namespaced per service so two
  // services can declare the same key without colliding in the top-level block.
  const secretKeys = ctx.serviceSecretKeys?.get(m.id) ?? [];
  if (secretKeys.length > 0) {
    snippet.secrets = secretKeys.map((key) => ({
      source: serviceSecretName(m.id, key),
      target: key,
    }));
    const env = snippet.environment ?? {};
    for (const key of secretKeys) env[`${key}_FILE`] = `/run/secrets/${key}`;
    snippet.environment = env;
  }
  if (c.workingDir) snippet.working_dir = c.workingDir;
  if (c.user) snippet.user = c.user;
  if (c.shmSize) snippet.shm_size = c.shmSize;
  if (c.capAdd?.length) snippet.cap_add = c.capAdd;
  if (c.capDrop?.length) snippet.cap_drop = c.capDrop;
  if (c.devices?.length) snippet.devices = c.devices;
  if (c.privileged) snippet.privileged = true;

  if (c.networkMode === "host") {
    snippet.network_mode = "host";
  } else if (c.networkAliases?.length) {
    // Docker Compose long-form: `networks: { openmapx: { aliases: [...] } }`.
    // Other containers on the openmapx network can address this service via
    // any listed alias in addition to the service id.
    snippet.networks = { openmapx: { aliases: [...c.networkAliases] } };
  } else {
    snippet.networks = ["openmapx"];
  }

  const volumes: string[] = [];
  for (const v of m.volumes ?? []) {
    volumes.push(`${v.name}:${v.mountAt}${v.readOnly ? ":ro" : ""}`);
  }
  for (const cs of m.consumes ?? []) {
    const sourcePath = ctx.consumesPaths?.get(consumesKey(cs));
    if (sourcePath) {
      volumes.push(`${sourcePath}:${cs.mountAt}${cs.readOnly ? ":ro" : ""}`);
    }
  }
  const exists = ctx.existsSync ?? existsSync;
  for (const bm of m.bindMounts ?? []) {
    const resolved = resolveBindSource(
      bm,
      service,
      ctx.allServices ?? [service],
      ctx.composeOutDir,
    );
    // `optional: true` + resolvable host path + path missing → skip the mount
    // and surface an advisory. If the host path can't be resolved (only true
    // for `$VAR` sources, which the manifest schema rejects with `optional`),
    // fall through to emitting the mount as a defensive no-op.
    if (bm.optional && resolved.absoluteHostPath && !exists(resolved.absoluteHostPath)) {
      ctx.warnings?.push(
        `service "${m.id}": skipping optional bind-mount: ${bm.source} → ${bm.target} (host source not present at ${resolved.absoluteHostPath})`,
      );
      continue;
    }
    // readOnly defaults to true for bind mounts (config files, docker socket)
    const readOnly = bm.readOnly !== false;
    volumes.push(`${resolved.src}:${bm.target}${readOnly ? ":ro" : ""}`);
    // A writable `@infra:data/...` source is a data dir the container (and the
    // data-manager pipeline) writes into. Record it so the deploy step can
    // pre-create it owned by the data UID before compose up; otherwise docker
    // auto-creates it as root and the non-root container can't write.
    if (
      !readOnly &&
      resolved.absoluteHostPath &&
      bm.source.startsWith(`${INFRA_BIND_PREFIX}data/`)
    ) {
      ctx.bindDirSink?.push(resolved.absoluteHostPath);
    }
  }
  if (volumes.length) snippet.volumes = volumes;

  // A non-root container that mounts the docker socket needs the socket's group
  // to use it (it's root:docker, mode 660). The gid is host-specific, so it
  // comes from DOCKER_GID in the env — required, because docker access is the
  // whole point of mounting the socket and a wrong/absent gid just yields a
  // "permission denied" at runtime that's painful to diagnose.
  if ((m.bindMounts ?? []).some((bm) => bm.source === "@docker-socket")) {
    snippet.group_add = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal docker-compose variable interpolation, not a JS template
      "${DOCKER_GID:?DOCKER_GID must be set to the host docker socket group id — find it with: stat -c %g /var/run/docker.sock}",
    ];
  }

  if (m.exposure?.proxy?.enabled) {
    snippet.labels = renderTraefikLabels(m, ctx);
  }

  if (c.restart) snippet.restart = c.restart;

  if (c.healthcheck) {
    snippet.healthcheck = renderHealthcheck(c.healthcheck, c);
  }

  if (c.dependsOn?.length) {
    snippet.depends_on = Object.fromEntries(
      c.dependsOn.map((d) => [d.service, { condition: d.condition ?? "service_started" }]),
    );
  }

  if (c.logging) snippet.logging = c.logging;
  if (c.memory || c.gpu) {
    const resources: NonNullable<NonNullable<typeof snippet.deploy>["resources"]> = {};
    if (c.memory) resources.limits = { memory: c.memory };
    if (c.gpu) {
      resources.reservations = {
        devices: [{ driver: c.gpu.driver, count: c.gpu.count, capabilities: c.gpu.capabilities }],
      };
    }
    snippet.deploy = { resources };
  }

  return snippet;
}

function renderHealthcheck(
  hc: NonNullable<ServiceManifest["container"]["healthcheck"]>,
  container: ServiceManifest["container"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (hc.type === "http") {
    const port = hc.port ?? container.expose?.[0] ?? 80;
    const path = hc.path ?? "/";
    // Use `127.0.0.1`, not `localhost`: `localhost` resolves to `::1` first and
    // an IPv4-only server (e.g. MOTIS binds 0.0.0.0 = IPv4) refuses it. Fall back
    // to wget so images that ship no curl (again, MOTIS) still get a working
    // probe; if neither client exists the `|| exit 1` keeps it unhealthy.
    const url = `http://127.0.0.1:${port}${path}`;
    out.test = [
      "CMD-SHELL",
      `curl -fsS ${url} -o /dev/null 2>/dev/null || wget -q -O /dev/null ${url} 2>/dev/null || exit 1`,
    ];
  } else if (hc.type === "tcp") {
    const port = hc.port ?? container.expose?.[0] ?? 80;
    out.test = ["CMD-SHELL", `nc -z localhost ${port} || exit 1`];
  } else if (hc.type === "exec" && hc.command) {
    out.test = Array.isArray(hc.command) ? ["CMD", ...hc.command] : ["CMD-SHELL", hc.command];
  }
  if (hc.interval) out.interval = hc.interval;
  if (hc.timeout) out.timeout = hc.timeout;
  if (hc.retries !== undefined) out.retries = hc.retries;
  if (hc.startPeriod) out.start_period = hc.startPeriod;
  return out;
}

function renderTraefikLabels(m: ServiceManifest, ctx: RenderContext): Record<string, string> {
  const proxy = m.exposure?.proxy;
  if (!proxy?.enabled) return {};

  const id = m.id;
  const domain = ctx.domain ?? "localhost";
  const pathPrefix = proxy.pathPrefix ?? `/${id}`;
  const targetPort = m.container.expose?.[0] ?? 80;

  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${id}.rule`]: `Host(\`${domain}\`) && PathPrefix(\`${pathPrefix}\`)`,
    [`traefik.http.routers.${id}.entrypoints`]: "websecure",
    [`traefik.http.routers.${id}.tls.certresolver`]: "letsencrypt",
    [`traefik.http.services.${id}.loadbalancer.server.port`]: String(targetPort),
  };

  const middlewares: string[] = [];
  if (proxy.stripPrefix) {
    labels[`traefik.http.middlewares.${id}-strip.stripprefix.prefixes`] = pathPrefix;
    middlewares.push(`${id}-strip`);
  }
  for (const mw of proxy.middleware ?? []) middlewares.push(mw);
  if (middlewares.length) {
    labels[`traefik.http.routers.${id}.middlewares`] = middlewares.join(",");
  }

  if (typeof proxy.priority === "number") {
    labels[`traefik.http.routers.${id}.priority`] = String(proxy.priority);
  }

  // Additional routes — each emits a separate Traefik router but reuses the
  // same `traefik.http.services.${id}` backend so all routes hit the same
  // container port. Useful for a single API exposing both `/api/*` and `/health`.
  const additionalRoutes = proxy.additionalRoutes ?? [];
  for (let i = 0; i < additionalRoutes.length; i++) {
    const route = additionalRoutes[i];
    if (!route) continue;
    const routerName = `${id}-r${i + 1}`;
    const matcher = route.path ? `Path(\`${route.path}\`)` : `PathPrefix(\`${route.pathPrefix}\`)`;
    labels[`traefik.http.routers.${routerName}.rule`] = `Host(\`${domain}\`) && ${matcher}`;
    labels[`traefik.http.routers.${routerName}.entrypoints`] = "websecure";
    labels[`traefik.http.routers.${routerName}.tls.certresolver`] = "letsencrypt";
    labels[`traefik.http.routers.${routerName}.service`] = id;
    if (route.middleware?.length) {
      labels[`traefik.http.routers.${routerName}.middlewares`] = route.middleware.join(",");
    }
  }

  return labels;
}

function topologicalOrder(services: LoadedService[]): LoadedService[] {
  // Mirror the same instance-aware lookup as `detectConsumesCycle` so multi-
  // region producer setups order correctly.
  const defaultProducers = new Map<string, string>();
  const instancedProducers = new Map<string, string>();
  const producersByType = new Map<string, string[]>();
  for (const s of services) {
    for (const p of s.manifest.produces ?? []) {
      if (p.instance === undefined) {
        defaultProducers.set(p.type, s.manifest.id);
      } else {
        instancedProducers.set(`${p.type}/${p.instance}`, s.manifest.id);
      }
      const list = producersByType.get(p.type) ?? [];
      list.push(s.manifest.id);
      producersByType.set(p.type, list);
    }
  }
  const adj = new Map<string, Set<string>>();
  for (const s of services) {
    const upstream = new Set<string>();
    for (const c of s.manifest.consumes ?? []) {
      let producer: string | undefined;
      if (c.instance !== undefined) {
        producer = instancedProducers.get(`${c.type}/${c.instance}`);
      } else {
        producer =
          defaultProducers.get(c.type) ??
          (producersByType.get(c.type)?.length === 1
            ? producersByType.get(c.type)?.[0]
            : undefined);
      }
      if (producer && producer !== s.manifest.id) upstream.add(producer);
    }
    adj.set(s.manifest.id, upstream);
  }

  const visited = new Set<string>();
  const result: LoadedService[] = [];
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of adj.get(id) ?? []) visit(dep);
    const found = services.find((s) => s.manifest.id === id);
    if (found) result.push(found);
  }
  for (const s of services) visit(s.manifest.id);
  return result;
}

export function renderCompose(services: LoadedService[], ctx: RenderContext): RenderResult {
  const cycle = detectConsumesCycle(services);
  if (cycle) {
    throw new Error(
      `Cycle detected in consumes/produces graph involving services: ${cycle.join(" → ")}`,
    );
  }

  // Build the producer index FIRST — it throws on duplicate
  // (type, instance) pairs, and we want that error to surface before any
  // other work. Topological order then runs against a registry we know is
  // structurally sound.
  const producerIndex = buildProducerIndex(services);
  const sorted = topologicalOrder(services);

  // Hardlink plan: for each consumer entry, look up the matching producer
  // (instance-aware) and emit one entry. The target dir nests `<instance>`
  // when present so multi-region setups keep separate dirs on disk.
  const hardlinkPlan: HardlinkEntry[] = [];
  const resolvedConsumesPathsByService = new Map<string, Map<string, string>>();
  for (const s of services) {
    for (const c of s.manifest.consumes ?? []) {
      const producer = resolveProducer(c, s.manifest.id, producerIndex);
      if (!producer) continue;
      const target = hardlinkTargetDir(s.manifest.id, c);
      hardlinkPlan.push({
        source: producer.produces.sourceDir,
        target,
        consumerService: s.manifest.id,
        dataType: c.type,
        ...(producer.produces.instance ? { instance: producer.produces.instance } : {}),
        ...(c.targetFilename ? { targetFilename: c.targetFilename } : {}),
      });
      const paths = resolvedConsumesPathsByService.get(s.manifest.id) ?? new Map<string, string>();
      paths.set(consumesKey(c), `./${target}`);
      resolvedConsumesPathsByService.set(s.manifest.id, paths);
    }
  }

  // Single sink shared across every snippet render so `RenderResult.warnings`
  // surfaces every skipped optional bind-mount in one pass. Callers can also
  // pre-allocate `ctx.warnings` to capture into their own array.
  const warnings: string[] = ctx.warnings ?? [];
  const bindDirSink: string[] = ctx.bindDirSink ?? [];

  const composeServices: Record<string, ComposeServiceSnippet> = {};
  for (const s of sorted) {
    if (!s.enabled) continue;
    // Per-consumer mount-path map: only resolved producer-backed consumes
    // entries are mounted. Missing optional producers stay absent instead of
    // becoming empty local bind directories.
    const consumesPaths =
      resolvedConsumesPathsByService.get(s.manifest.id) ?? new Map<string, string>();
    composeServices[s.manifest.id] = renderServiceSnippet(s, {
      ...ctx,
      allServices: ctx.allServices ?? services,
      consumesPaths,
      warnings,
      bindDirSink,
    });
  }

  // Pinned container names must be unique across the rendered stack — docker
  // rejects a duplicate `container_name` at `up` time, so fail closed here at
  // render rather than letting it blow up on deploy.
  const containerNameOwner = new Map<string, string>();
  for (const [serviceId, snippet] of Object.entries(composeServices)) {
    const name = snippet.container_name;
    if (!name) continue;
    const existing = containerNameOwner.get(name);
    if (existing) {
      throw new Error(
        `Duplicate container_name "${name}" on services "${existing}" and "${serviceId}". Pinned container names must be unique across the stack.`,
      );
    }
    containerNameOwner.set(name, serviceId);
  }

  const namedVolumes: Record<string, null> = {};
  for (const s of services) {
    for (const v of s.manifest.volumes ?? []) {
      namedVolumes[v.name] = null;
    }
  }

  // Top-level `secrets:` block: one entry per (service, vault key) in the
  // caller-supplied map, each a file source the app-api render step
  // materialises. Deliberately NOT limited to the services rendered in this
  // pass: the DB-free CLI's only durable record of vault key names is this
  // block, so a narrowed render (`--services`/`--preset`) must keep carrying
  // the entries of the services it excludes — dropping them here would make
  // the next full CLI render silently strip those credentials (real prod
  // incident: every keyed road-conditions feed ran uncredentialed). Top-level
  // secrets unreferenced by any rendered service are inert to docker compose.
  // The app-api render path only ever passes keys for enabled services, so its
  // output is unchanged.
  const composeSecrets: Record<string, { file: string }> = {};
  for (const [serviceId, keys] of ctx.serviceSecretKeys ?? []) {
    for (const key of keys) {
      composeSecrets[serviceSecretName(serviceId, key)] = {
        file: serviceSecretFilePath(serviceId, key),
      };
    }
  }

  const composeDoc = {
    services: composeServices,
    networks: {
      openmapx: {
        driver: "bridge",
        // Dual-stack so containers get IPv6 addresses and published ports
        // (Traefik's 80/443) are reachable over IPv6 on the host. The explicit
        // ULA subnet avoids depending on the daemon's IPv6 default-address-pools
        // (not configured out of the box), which would otherwise fail network
        // creation on engines without the auto-ULA behaviour. Host-side IPv6
        // publishing additionally requires the daemon's `ip6tables` to be on
        // (default in Docker Engine 27+).
        enable_ipv6: true,
        ipam: { config: [{ subnet: "fd4d:5058::/64" }] },
      },
    },
    ...(Object.keys(namedVolumes).length ? { volumes: namedVolumes } : {}),
    ...(Object.keys(composeSecrets).length ? { secrets: composeSecrets } : {}),
  };

  const composeYaml = yamlDump(composeDoc, { lineWidth: 120, noRefs: true });

  const writableBindDirs = [...new Set(bindDirSink)];

  return {
    composeYaml,
    hardlinkPlan,
    ...(warnings.length ? { warnings } : {}),
    ...(writableBindDirs.length ? { writableBindDirs } : {}),
  };
}
