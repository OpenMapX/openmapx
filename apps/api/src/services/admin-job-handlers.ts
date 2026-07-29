import { isAbsolute, relative, resolve } from "node:path";
import { validatePublicUrl } from "@openmapx/core";
import { findRepoRoot } from "@openmapx/core/server";
import { assertValidBackupName, runOpenmapxCliJobCommand } from "./admin-cli";
import type { JobContext } from "./job-runner";
import { getServiceRegistry } from "./service-registry";

type DataOperation =
  | "download-osm"
  | "download-gtfs"
  | "download-style"
  | "update"
  | "convert-overpass"
  | "link"
  | "clean"
  | "generate-api-keys"
  | "overture-sync"
  | "overture-conflate";

type BackupOperation = "create" | "restore" | "delete";
type BulkServiceAction = "start" | "stop" | "restart" | "update" | "build";

function nonEmptyString(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((id) => id.length > 0);
}

// Argv-injection guards.
//
// `runOpenmapxCliJobCommand` spawns `node packages/cli/src/index.ts ...args` via
// `spawn(...)` (no shell), so untrusted strings cannot break out of argv. They
// can, however, still reach commander as flags if they begin with `-` —
// e.g. `serviceIds: ["--preset=app"]` would inject a known option. Each helper
// below pins an argv element to a known shape before it is forwarded to the
// CLI process.

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const REGION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_/.-]*$/;
// Used for `--countries` (comma-separated ISO-3166 alpha-2/3 codes).
const COUNTRIES_RE = /^[a-zA-Z]{2,3}(,[a-zA-Z]{2,3})*$/;

function rejectFlagLike(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new Error(`${label} must not begin with "-"`);
  }
}

function assertSlug(value: string, label: string): void {
  rejectFlagLike(value, label);
  if (!SLUG_RE.test(value)) {
    throw new Error(`${label} must be a slug (alphanumeric, ".", "_", "-")`);
  }
}

function assertRegion(value: string): void {
  rejectFlagLike(value, "region");
  if (value.includes("..") || !REGION_RE.test(value)) {
    throw new Error('region must match /^[A-Za-z0-9][A-Za-z0-9_/.-]*$/ and contain no ".."');
  }
}

function assertCountries(value: string): void {
  rejectFlagLike(value, "countries");
  if (!COUNTRIES_RE.test(value)) {
    throw new Error("countries must be a comma-separated list of ISO country codes");
  }
}

/** Throws unless `path` is absolute (or resolves to) inside the repo root. */
function assertInsideRepo(path: string, label: string): string {
  rejectFlagLike(path, label);
  const root = findRepoRoot();
  const resolved = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must resolve to a path inside the repo root`);
  }
  return resolved;
}

/** Validates each id in `serviceIds` exists in the registry. Throws on first miss. */
function assertKnownServiceIds(serviceIds: string[]): void {
  if (serviceIds.length === 0) return;
  let registry: ReturnType<typeof getServiceRegistry>;
  try {
    registry = getServiceRegistry();
  } catch {
    // Registry not initialized (cold start) — fall back to slug-shape check
    // only. This is the same posture the admin route takes.
    for (const id of serviceIds) assertSlug(id, "serviceId");
    return;
  }
  const known = new Set(registry.list().map((s) => s.manifest.id));
  for (const id of serviceIds) {
    assertSlug(id, "serviceId");
    if (!known.has(id)) {
      throw new Error(`Unknown serviceId: "${id}"`);
    }
  }
}

export async function handleDataOperationJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as {
    operation?: DataOperation;
    region?: string;
    countries?: string;
    feedsFile?: string;
    failFast?: boolean;
    target?: string;
    repoUrl?: string;
    output?: string;
    restart?: boolean;
  };

  const op = payload.operation;
  if (!op) throw new Error("Missing data operation");

  const args: string[] = ["data"];
  switch (op) {
    case "download-osm": {
      args.push("download", "osm");
      const region = nonEmptyString(payload.region);
      if (region) {
        assertRegion(region);
        args.push(region);
      }
      break;
    }
    case "download-gtfs": {
      args.push("download", "gtfs");
      const countries = nonEmptyString(payload.countries);
      const feedsFile = nonEmptyString(payload.feedsFile);
      if (countries) {
        assertCountries(countries);
        args.push("--countries", countries);
      }
      if (feedsFile) {
        const safe = assertInsideRepo(feedsFile, "feedsFile");
        args.push("--feeds-file", safe);
      }
      break;
    }
    case "download-style": {
      args.push("download", "style");
      break;
    }
    case "update": {
      args.push("update");
      const region = nonEmptyString(payload.region);
      const countries = nonEmptyString(payload.countries);
      const feedsFile = nonEmptyString(payload.feedsFile);
      if (region) {
        assertRegion(region);
        args.push(region);
      }
      if (countries) {
        assertCountries(countries);
        args.push("--countries", countries);
      }
      if (feedsFile) {
        const safe = assertInsideRepo(feedsFile, "feedsFile");
        args.push("--feeds-file", safe);
      }
      if (payload.failFast === true) args.push("--fail-fast");
      break;
    }
    case "convert-overpass": {
      args.push("convert", "overpass");
      const region = nonEmptyString(payload.region);
      if (region) {
        assertRegion(region);
        args.push(region);
      }
      break;
    }
    case "link": {
      args.push("link");
      break;
    }
    case "clean": {
      const target = nonEmptyString(payload.target);
      if (!target) throw new Error("clean operation requires target");
      // The CLI's `clean` accepts a data-type alias or "all" — both fit the
      // slug shape and do not begin with "-".
      assertSlug(target, "target");
      args.push("clean", target);
      break;
    }
    case "generate-api-keys": {
      args.push("generate-api-keys");
      const repoUrl = nonEmptyString(payload.repoUrl);
      const output = nonEmptyString(payload.output);
      if (repoUrl) {
        // SSRF posture: reject private/loopback/etc. and force https.
        validatePublicUrl(repoUrl);
        if (!/^https:/i.test(repoUrl)) throw new Error("repoUrl must use https");
        rejectFlagLike(repoUrl, "repoUrl");
        args.push("--repo-url", repoUrl);
      }
      if (output) {
        const safe = assertInsideRepo(output, "output");
        args.push("--output", safe);
      }
      break;
    }
    case "overture-sync": {
      args.push("overture-sync");
      const region = nonEmptyString(payload.region);
      if (!region) throw new Error("overture-sync requires region");
      assertRegion(region);
      args.push(region);
      break;
    }
    case "overture-conflate": {
      args.push("overture-conflate");
      const region = nonEmptyString(payload.region);
      if (!region) throw new Error("overture-conflate requires region");
      assertRegion(region);
      args.push(region);
      if (payload.restart === true) args.push("--restart");
      break;
    }
    default:
      throw new Error(`Unsupported data operation: ${String(op)}`);
  }

  await runOpenmapxCliJobCommand(ctx, args);
  return { operation: op, args };
}

export async function handleBackupOperationJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as {
    operation?: BackupOperation;
    name?: string;
    serviceIds?: string[];
    stopRunning?: boolean;
  };

  const op = payload.operation;
  if (!op) throw new Error("Missing backup operation");

  const args: string[] = ["backup"];
  switch (op) {
    case "create": {
      args.push("create");
      const name = nonEmptyString(payload.name);
      // When `name` is absent the CLI generates a safe ISO-timestamp default
      // (`defaultBackupName`); only validate when the operator picked one.
      if (name) {
        assertValidBackupName(name);
        args.push("--name", name);
      }
      break;
    }
    case "restore": {
      const name = nonEmptyString(payload.name);
      if (!name) throw new Error("restore operation requires name");
      assertValidBackupName(name);
      args.push("restore", name);
      const serviceIds = toIdList(payload.serviceIds);
      if (serviceIds.length > 0) {
        assertKnownServiceIds(serviceIds);
        args.push("--services", ...serviceIds);
      }
      if (payload.stopRunning === true) args.push("--stop-running");
      break;
    }
    case "delete": {
      const name = nonEmptyString(payload.name);
      if (!name) throw new Error("delete operation requires name");
      assertValidBackupName(name);
      args.push("delete", name);
      break;
    }
    default:
      throw new Error(`Unsupported backup operation: ${String(op)}`);
  }

  await runOpenmapxCliJobCommand(ctx, args);
  return { operation: op, args };
}

export async function handleServiceBulkJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as {
    action?: BulkServiceAction;
    serviceIds?: string[];
    all?: boolean;
    region?: string;
    continueOnError?: boolean;
  };

  const action = payload.action;
  if (!action) throw new Error("Missing bulk service action");
  const serviceIds = toIdList(payload.serviceIds);
  assertKnownServiceIds(serviceIds);

  const args: string[] = ["services"];
  if (action === "build") {
    const region = nonEmptyString(payload.region);
    if (region) assertRegion(region);
    if (payload.all === true || serviceIds.length === 0) {
      args.push("build-all");
      if (region) args.push("--region", region);
      if (payload.continueOnError === false) args.push("--fail-fast");
    } else {
      args.push("build", ...serviceIds);
      if (region) args.push("--region", region);
      if (payload.continueOnError === true) args.push("--continue-on-error");
    }
  } else {
    if (serviceIds.length === 0) {
      throw new Error(`Bulk action "${action}" requires one or more services`);
    }
    args.push(action, ...serviceIds);
  }

  await runOpenmapxCliJobCommand(ctx, args);
  return { action, args, serviceIds };
}

// Re-exported for tests. Keep the surface minimal — test-only helpers should
// not be imported by route handlers.
export const _argvGuards = {
  assertSlug,
  assertRegion,
  assertCountries,
  assertInsideRepo,
  assertKnownServiceIds,
  rejectFlagLike,
};
