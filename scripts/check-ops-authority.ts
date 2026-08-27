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
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The single component allowed to reach the Docker daemon. */
const AUTHORITY_SERVICE = "ops-agent";

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
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bindMounts?: Array<{ source?: unknown; target?: unknown }>;
    };
    for (const mount of manifest.bindMounts ?? []) {
      const source = typeof mount.source === "string" ? mount.source : "";
      const target = typeof mount.target === "string" ? mount.target : "";
      if (serviceId === AUTHORITY_SERVICE) continue;

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
