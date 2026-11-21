/**
 * Host-authority policy gate.
 *
 * The operations agent is the only component permitted to hold host authority.
 * This fails the build if a Docker socket mount, Docker credentials, a host
 * repository-root mount, a Docker provider, or a direct Docker process
 * invocation appears anywhere else — the exact
 * regression that would silently hand host control back to an internet-facing
 * service.
 *
 * The bidirectional inventory in `ops-authority-inventory.test.ts` remains the
 * detailed contract; this script is the coarse, fast gate wired into
 * `check:policy` so CI fails on a reintroduction even when tests are skipped.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The single component allowed to reach the Docker daemon. */
const AUTHORITY_SERVICE = "ops-agent";

/** The agent's state, relative to the checkout. */
const AGENT_STATE = "infra/docker/state";

/** The API service, the one service that may mount the agent's integration store. */
const API_SERVICE = "api";
/** The part of the agent's state the API may mount, read-only: the integrations the agent installed. */
const AGENT_INTEGRATION_STORE = `${AGENT_STATE}/ops-agent/custom-integrations`;
/** Data-manager's own private control records, which only it mounts. */
const DATA_MANAGER_PRIVATE_STATE = `${AGENT_STATE}/data-manager/control`;
/** Traefik reads, read-only, its dynamic directory and its static file in the applied generation. */
const AGENT_TRAEFIK_FILES = new Set([
  `${AGENT_STATE}/ops-agent/traefik/dynamic`,
  `${AGENT_STATE}/ops-agent/configuration/current/traefik/traefik.yml`,
]);

/**
 * Secret files with a fixed set of holders. No other service may mount one,
 * alone or inside a wider mount; the operations agent alone mounts the whole
 * secrets directory, because it renders the configuration, and it holds the
 * Docker socket, which reaches every file anyway.
 */
const SECRET_HOLDERS: Readonly<Record<string, readonly string[]>> = {
  "infra/docker/secrets/data-manager-api-token": ["data-manager", API_SERVICE],
  "infra/docker/secrets/data-manager-ops-agent-token": ["data-manager", "ops-agent"],
  "infra/docker/secrets/data-manager-host-cli-token": ["data-manager"],
  "infra/docker/secrets/postgres-api-password": ["postgis", API_SERVICE],
  "infra/docker/secrets/postgres-data-manager-password": ["postgis", "data-manager"],
};
/** Any data-manager caller token, including one of a caller that does not exist. */
const DATA_MANAGER_TOKEN = /^infra\/docker\/secrets\/data-manager-.+-token$/;

/** The role each service connects to the platform database as, and that role's password file. */
const DATABASE_ROLE_OF_SERVICE: Readonly<Record<string, { role: string; password: string }>> = {
  [API_SERVICE]: { role: "openmapx_api", password: "infra/docker/secrets/postgres-api-password" },
  "data-manager": {
    role: "openmapx_data_manager",
    password: "infra/docker/secrets/postgres-data-manager-password",
  },
};
const SUPERUSER_DATABASE_URL = /postgres(?:ql)?:\/\/postgres[:@]/;
/** A Compose reference to the superuser's password: `$POSTGRES_PASSWORD` or `${POSTGRES_PASSWORD…}`. */
const SUPERUSER_PASSWORD_REFERENCE = /\$\{?POSTGRES_PASSWORD(?![A-Za-z0-9_])/;

/** `$OPENMAPX_HOST_DIR`, `${OPENMAPX_HOST_DIR}` or `${OPENMAPX_HOST_DIR:?…}`, then the rest of the path. */
const HOST_DIR_SOURCE =
  /^\$(?:OPENMAPX_HOST_DIR(?![A-Za-z0-9_])|\{OPENMAPX_HOST_DIR(?:[:?+-][^}]*)?\})(.*)$/s;

/**
 * Where a bind source resolves in the checkout, as a normalized relative path
 * (`..` when it leaves the checkout), or `null` when it cannot be known here:
 * another Compose variable anywhere in it, or an absolute host path.
 */
function checkoutPath(serviceId: string, source: string): string | null {
  const within = (...parts: string[]) => posix.normalize(posix.join(...parts)).replace(/\/+$/, "");
  const [, hostDirRest] = HOST_DIR_SOURCE.exec(source) ?? [];
  // Compose interpolates a `$` anywhere in the rendered path.
  if ((hostDirRest ?? source).includes("$")) return null;
  if (hostDirRest !== undefined) return within(".", hostDirRest);
  if (source.startsWith("/")) return null;
  if (source.startsWith("@infra:")) return within("infra/docker", source.slice("@infra:".length));
  if (source.startsWith("@service:")) {
    const rest = source.slice("@service:".length);
    const colon = rest.indexOf(":");
    return colon < 0 ? null : within("services", rest.slice(0, colon), rest.slice(colon + 1));
  }
  return within("services", serviceId, source);
}

/**
 * Whether a checkout path holds the agent's state: the state directory or
 * anything below it, a directory containing it (up to the checkout and
 * beyond), or one of the dot entries in `infra/docker` (generations, `.env`).
 */
function reachesAgentState(path: string): boolean {
  const containsState =
    path === "." ||
    path === ".." ||
    path.startsWith("../") ||
    `${AGENT_STATE}/`.startsWith(`${path}/`);
  return (
    containsState ||
    path === AGENT_STATE ||
    path.startsWith(`${AGENT_STATE}/`) ||
    path.startsWith("infra/docker/.")
  );
}

/** Directories whose production TypeScript must not invoke Docker directly. */
const PRODUCTION_SOURCE_ROOTS = [
  join("apps", "api", "src"),
  join("services", "data-manager", "src"),
];

const DOCKER_INVOCATION =
  /\b(?:execa|execFile|execFileSync|spawn|spawnSync|exec)\s*\(\s*(['"`])docker\1/;

/**
 * Exclusive access to targets is held in the agent's lease store only. The
 * shared admission directory on the data volume, which every role could write,
 * must not come back in code, tests, manifests or scripts.
 */
const SHARED_ADMISSION_DIRECTORY = [".admin", "target", "control"].join("-");
const ADMISSION_SCAN_ROOTS = ["apps", "services", "packages", "scripts"];
const ADMISSION_SCAN_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".json", ".sh", ".yml"];

function walkAll(directory: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }
  for (const name of entries) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (["node_modules", "dist", ".turbo", ".next", "coverage"].includes(name)) continue;
      files.push(...walkAll(path));
    } else if (ADMISSION_SCAN_EXTENSIONS.some((extension) => name.endsWith(extension))) {
      files.push(path);
    }
  }
  return files;
}

export interface AuthorityViolation {
  file: string;
  detail: string;
}

function walk(directory: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }
  for (const name of entries) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
      files.push(...walk(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

function serviceManifests(root: string): string[] {
  const servicesDir = join(root, "services");
  let entries: string[];
  try {
    entries = readdirSync(servicesDir);
  } catch {
    return [];
  }
  return entries
    .map((name) => join(servicesDir, name, "service.json"))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * Every service ID this gate names in its rules and exceptions. A rule keyed
 * by an ID no manifest has silently never applies, so a renamed or removed
 * service must fail the gate instead.
 */
const NAMED_SERVICE_IDS = [
  ...new Set([
    AUTHORITY_SERVICE,
    API_SERVICE,
    "data-manager",
    "postgis",
    "traefik",
    ...Object.values(SECRET_HOLDERS).flat(),
    ...Object.keys(DATABASE_ROLE_OF_SERVICE),
  ]),
].sort();

/** The service IDs this gate names that have no `services/<id>/service.json` under `root`. */
export function findUnknownNamedServices(
  root: string = ROOT,
  serviceIds: readonly string[] = NAMED_SERVICE_IDS,
): AuthorityViolation[] {
  const known = new Set(serviceManifests(root).map((path) => basename(dirname(path))));
  return serviceIds
    .filter((serviceId) => !known.has(serviceId))
    .map((serviceId) => ({
      file: "scripts/check-ops-authority.ts",
      detail: `names service "${serviceId}", which has no services/${serviceId}/service.json`,
    }));
}

export function findAuthorityViolations(root: string = ROOT): AuthorityViolation[] {
  const violations: AuthorityViolation[] = [];

  for (const manifestPath of serviceManifests(root)) {
    const serviceId = relative(root, dirname(manifestPath)).replace(/^.*[/\\]/s, "");
    const text = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(text) as {
      container?: { environment?: Record<string, unknown> };
      bindMounts?: Array<{
        source?: unknown;
        target?: unknown;
        readOnly?: unknown;
        writableCopy?: unknown;
      }>;
    };
    const file = relative(root, manifestPath);
    const mounts = (manifest.bindMounts ?? []).map((mount) => ({
      source: typeof mount.source === "string" ? mount.source : "",
      target: typeof mount.target === "string" ? mount.target : "",
    }));

    // Data-manager tokens and database role passwords stay with their holders.
    for (const { source } of mounts) {
      const path = checkoutPath(serviceId, source);
      if (path === null) continue;
      if (DATA_MANAGER_TOKEN.test(path) && !(path in SECRET_HOLDERS))
        violations.push({
          file,
          detail: `service "${serviceId}" mounts an unknown data-manager token (${source})`,
        });
      for (const [secret, holders] of Object.entries(SECRET_HOLDERS)) {
        const name = posix.basename(secret);
        if (path === secret && !holders.includes(serviceId))
          violations.push({ file, detail: `service "${serviceId}" mounts ${name} (${source})` });
        else if (
          serviceId !== AUTHORITY_SERVICE &&
          (secret.startsWith(`${path}/`) || path === "." || path.startsWith(".."))
        )
          violations.push({
            file,
            detail: `service "${serviceId}" reaches ${name} through ${source}`,
          });
      }
    }

    // Only PostGIS itself uses the database superuser; the API and
    // data-manager connect as their own roles.
    if (serviceId !== "postgis" && SUPERUSER_DATABASE_URL.test(text))
      violations.push({
        file,
        detail: `service "${serviceId}" connects to PostgreSQL as the superuser`,
      });
    // Nor does any other service receive its password, under any name: a
    // service with its own database (Nominatim) gets its own password.
    if (serviceId !== "postgis" && SUPERUSER_PASSWORD_REFERENCE.test(text))
      violations.push({
        file,
        detail: `service "${serviceId}" receives the PostgreSQL superuser password`,
      });
    // A missing URL would fall back to the code's superuser default.
    const database = DATABASE_ROLE_OF_SERVICE[serviceId];
    const environment = manifest.container?.environment;
    if (database !== undefined && manifest.container !== undefined) {
      const url = environment?.DATABASE_URL;
      if (typeof url !== "string" || !url.startsWith(`postgresql://${database.role}@`))
        violations.push({
          file,
          detail: `service "${serviceId}" must connect to PostgreSQL as ${database.role}, without a password in the URL`,
        });
      const own = mounts.find(
        (mount) => checkoutPath(serviceId, mount.source) === database.password,
      );
      if (own === undefined || environment?.DATABASE_PASSWORD_FILE !== own.target)
        violations.push({
          file,
          detail: `service "${serviceId}" must read its database password from its own mounted ${posix.basename(database.password)}`,
        });
    }

    for (const mount of manifest.bindMounts ?? []) {
      const source = typeof mount.source === "string" ? mount.source : "";
      const target = typeof mount.target === "string" ? mount.target : "";
      // Bind mounts are read-only unless a manifest says otherwise.
      const readOnly = mount.readOnly !== false;
      if (serviceId === AUTHORITY_SERVICE) continue;

      // A writable copy is what the container mounts, read-write, in place
      // of its source: it must stay out of the agent's state as well.
      if (mount.writableCopy !== undefined) {
        const copy = typeof mount.writableCopy === "string" ? mount.writableCopy : "";
        const path = copy.startsWith("@infra:") ? checkoutPath(serviceId, copy) : null;
        if (path === null || reachesAgentState(path)) {
          violations.push({
            file: relative(root, manifestPath),
            detail: `service "${serviceId}" has a writable copy outside the data directory (${copy})`,
          });
        }
      }

      const isSocket = source === "@docker-socket" || target.includes("docker.sock");
      if (isSocket) {
        violations.push({
          file: relative(root, manifestPath),
          detail: `service "${serviceId}" mounts the Docker socket`,
        });
      }
      // The repository root itself. A narrower `${HOST_DIR}/<subdir>` mount is
      // application data (extension artifacts), not repository authority; what
      // is forbidden is mounting the checkout itself.
      const mountsRepositoryRoot =
        source.includes("OPENMAPX_HOST_DIR") && target.includes("OPENMAPX_HOST_DIR");
      if (mountsRepositoryRoot) {
        violations.push({
          file: relative(root, manifestPath),
          detail: `service "${serviceId}" mounts the host repository root`,
        });
      }
      // The agent's own state (job journal, configuration candidates, privacy
      // scratch, stores). The API reads the integration store and nothing else;
      // every other service, data-manager above all, must not be able to reach
      // it, by whichever form of source. A source this gate cannot resolve is
      // refused rather than assumed to be safe.
      if (source !== "@docker-socket") {
        const path = checkoutPath(serviceId, source);
        if (path === null) {
          violations.push({
            file: relative(root, manifestPath),
            detail: `service "${serviceId}" mounts a host path this gate cannot place in the checkout (${source})`,
          });
        } else if (
          reachesAgentState(path) &&
          !(serviceId === API_SERVICE && path === AGENT_INTEGRATION_STORE && readOnly) &&
          !(serviceId === "traefik" && AGENT_TRAEFIK_FILES.has(path) && readOnly) &&
          !(serviceId === "data-manager" && path === DATA_MANAGER_PRIVATE_STATE)
        ) {
          violations.push({
            file: relative(root, manifestPath),
            detail: `service "${serviceId}" mounts the operations agent's state (${source})`,
          });
        }
      }
      if (source.includes("DOCKER_CONFIG_DIR") || target.endsWith("/.docker")) {
        violations.push({
          file: relative(root, manifestPath),
          detail: `service "${serviceId}" mounts Docker credentials`,
        });
      }
    }
  }

  // A Traefik-style Docker provider is socket access by another name.
  const traefikConfig = join(root, "services", "traefik", "config", "traefik.yml");
  try {
    const contents = readFileSync(traefikConfig, "utf8");
    if (/^\s*docker:\s*$/m.test(contents) || contents.includes("unix:///var/run/docker.sock")) {
      violations.push({
        file: relative(root, traefikConfig),
        detail: "Traefik declares a Docker provider",
      });
    }
  } catch {
    // No Traefik config in this checkout; nothing to enforce.
  }

  for (const sourceRoot of PRODUCTION_SOURCE_ROOTS) {
    for (const file of walk(join(root, sourceRoot))) {
      const contents = readFileSync(file, "utf8");
      if (DOCKER_INVOCATION.test(contents)) {
        violations.push({
          file: relative(root, file),
          detail: "invokes the Docker CLI directly",
        });
      }
    }
  }

  for (const scanRoot of ADMISSION_SCAN_ROOTS) {
    for (const file of walkAll(join(root, scanRoot))) {
      if (readFileSync(file, "utf8").includes(SHARED_ADMISSION_DIRECTORY)) {
        violations.push({
          file: relative(root, file),
          detail: `names the removed shared admission directory ${SHARED_ADMISSION_DIRECTORY}`,
        });
      }
    }
  }

  return violations;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ""))) {
  const violations = [...findUnknownNamedServices(), ...findAuthorityViolations()];
  if (violations.length > 0) {
    console.error("Host-authority policy violations:");
    for (const violation of violations) {
      console.error(`  ${violation.file}: ${violation.detail}`);
    }
    console.error(
      `\nOnly "${AUTHORITY_SERVICE}" may hold Docker authority. Model the effect as a typed ` +
        "operation instead of reaching the daemon directly.",
    );
    process.exit(1);
  }
  console.log(`Host authority is confined to "${AUTHORITY_SERVICE}".`);
}
