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
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The single component allowed to reach the Docker daemon. */
const AUTHORITY_SERVICE = "ops-agent";

/** The agent's state, relative to the checkout. */
const AGENT_STATE = "infra/docker/state";

/** The parts of the agent's state another service may mount: app-api's snapshot queue… */
const AGENT_TRUSTED_CONFIG_QUEUE = `${AGENT_STATE}/ops-agent/trusted-config`;
/** …and, read-only, the integrations the agent installed, which app-api loads. */
const AGENT_INTEGRATION_STORE = `${AGENT_STATE}/ops-agent/custom-integrations`;
/** Traefik reads, read-only, its dynamic directory and its static file in the applied generation. */
const AGENT_TRAEFIK_FILES = new Set([
  `${AGENT_STATE}/ops-agent/traefik/dynamic`,
  `${AGENT_STATE}/ops-agent/configuration/current/traefik/traefik.yml`,
]);

/** The services that hold a signed-control role, and the roles there are. */
const CONTROL_ROLE_OF_SERVICE: Readonly<Record<string, string>> = {
  "ops-agent": "ops-agent",
  "data-manager": "data-manager",
};
const CONTROL_ROLES = ["ops-agent", "data-manager", "host-cli"] as const;
const CONTROL_PRIVATE = "infra/docker/control-private";
/** What a sibling's key and private directory are hidden behind. */
const CONTROL_KEY_MASK = `${CONTROL_PRIVATE}/hidden-key`;
const CONTROL_DIRECTORY_MASK = `${CONTROL_PRIVATE}/empty`;

/**
 * Secret files with a fixed set of holders. No other service may mount one,
 * alone or inside a wider mount; the operations agent alone mounts the whole
 * secrets directory, because it renders the configuration, and it holds the
 * Docker socket, which reaches every file anyway.
 */
const SECRET_HOLDERS: Readonly<Record<string, readonly string[]>> = {
  "infra/docker/secrets/data-manager-api-token": ["data-manager", "app-api"],
  "infra/docker/secrets/data-manager-ops-agent-token": ["data-manager", "ops-agent"],
  "infra/docker/secrets/data-manager-host-cli-token": ["data-manager"],
  "infra/docker/secrets/postgres-api-password": ["postgis", "app-api"],
  "infra/docker/secrets/postgres-data-manager-password": ["postgis", "data-manager"],
};
/** Any data-manager caller token, including one of a caller that does not exist. */
const DATA_MANAGER_TOKEN = /^infra\/docker\/secrets\/data-manager-.+-token$/;

/** The role each service connects to the platform database as, and that role's password file. */
const DATABASE_ROLE_OF_SERVICE: Readonly<Record<string, { role: string; password: string }>> = {
  "app-api": { role: "openmapx_api", password: "infra/docker/secrets/postgres-api-password" },
  "data-manager": {
    role: "openmapx_data_manager",
    password: "infra/docker/secrets/postgres-data-manager-password",
  },
};
const SUPERUSER_DATABASE_URL = /postgres(?:ql)?:\/\/postgres[:@]/;

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
  const hostDir = HOST_DIR_SOURCE.exec(source);
  // Compose interpolates a `$` anywhere in the rendered path.
  const rest = hostDir ? (hostDir[1] as string) : source;
  if (rest.includes("$")) return null;
  if (hostDir) return within(".", rest);
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

/** A container path with every form of `$OPENMAPX_HOST_DIR` written the same way. */
function containerPath(target: string): string {
  return posix
    .normalize(
      target.replace(
        /\$(?:OPENMAPX_HOST_DIR(?![A-Za-z0-9_])|\{OPENMAPX_HOST_DIR(?:[:?+-][^}]*)?\})/g,
        "$OPENMAPX_HOST_DIR",
      ),
    )
    .replace(/\/+$/, "");
}

/**
 * A service may mount only its own control role's key and private directory.
 * A wider mount that contains a sibling role's key or directory is allowed
 * only when that sibling is hidden behind a mask mounted at its place.
 */
function controlViolations(
  serviceId: string,
  mounts: ReadonlyArray<{ source: string; target: string }>,
): string[] {
  const own = CONTROL_ROLE_OF_SERVICE[serviceId];
  const resolved = mounts.map((mount) => ({
    ...mount,
    path: checkoutPath(serviceId, mount.source),
    at: containerPath(mount.target),
  }));
  const details: string[] = [];
  for (const mount of resolved) {
    const path = mount.path;
    if (path === null || path === CONTROL_KEY_MASK || path === CONTROL_DIRECTORY_MASK) continue;
    for (const role of CONTROL_ROLES) {
      if (role === own) continue;
      for (const [sibling, mask, kind] of [
        [`infra/docker/secrets/control-${role}.key`, CONTROL_KEY_MASK, "key"],
        [`${CONTROL_PRIVATE}/${role}`, CONTROL_DIRECTORY_MASK, "private directory"],
      ] as const) {
        if (path === sibling || path.startsWith(`${sibling}/`)) {
          details.push(
            `service "${serviceId}" mounts the ${role} control ${kind} (${mount.source})`,
          );
        } else if (sibling.startsWith(`${path}/`) || path === "." || path.startsWith("..")) {
          const place = containerPath(posix.join(mount.at, posix.relative(path, sibling)));
          const masked = resolved.some((other) => other.path === mask && other.at === place);
          if (!masked)
            details.push(
              `service "${serviceId}" reaches the ${role} control ${kind} through ${mount.source} without a mask`,
            );
        }
      }
    }
  }
  return details;
}

/** Directories whose production TypeScript must not invoke Docker directly. */
const PRODUCTION_SOURCE_ROOTS = [
  join("apps", "api", "src"),
  join("services", "data-manager", "src"),
];

const DOCKER_INVOCATION =
  /\b(?:execa|execFile|execFileSync|spawn|spawnSync|exec)\s*\(\s*(['"`])docker\1/;

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

export function findAuthorityViolations(root: string = ROOT): AuthorityViolation[] {
  const violations: AuthorityViolation[] = [];

  for (const manifestPath of serviceManifests(root)) {
    const serviceId = relative(root, dirname(manifestPath)).split(/[/\\]/).at(-1) as string;
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

    // Signed-control keys and private records: each role reaches only its own.
    for (const detail of controlViolations(serviceId, mounts)) violations.push({ file, detail });

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
      // The agent's own state (job journal, trusted-config
      // queue, privacy scratch, stores). app-api publishes into the trusted-config
      // queue and reads the integration store, and nothing else; every other
      // service, data-manager above all,
      // must not be able to reach it, by whichever form of source. A source
      // this gate cannot resolve is refused rather than assumed to be safe.
      if (source !== "@docker-socket") {
        const path = checkoutPath(serviceId, source);
        if (path === null) {
          violations.push({
            file: relative(root, manifestPath),
            detail: `service "${serviceId}" mounts a host path this gate cannot place in the checkout (${source})`,
          });
        } else if (
          reachesAgentState(path) &&
          !(
            serviceId === "app-api" &&
            (path === AGENT_TRUSTED_CONFIG_QUEUE || (path === AGENT_INTEGRATION_STORE && readOnly))
          ) &&
          !(serviceId === "traefik" && AGENT_TRAEFIK_FILES.has(path) && readOnly)
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

  return violations;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ""))) {
  const violations = findAuthorityViolations();
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
