import z from "zod/v4";
import { componentIdSchema, isComponentId } from "./identifiers";

/**
 * One capability a service needs beyond the default sandbox, as the string an
 * administrator approves. A plain string sorts, compares and stores the same
 * way in JSON, in a database column and in the agent's record.
 */
export type GrantId =
  | `host-path:${string}:${"ro" | "rw"}`
  | "host-network"
  | `device:${string}`
  | "gpu"
  | `capability:${string}`
  | "privileged"
  | "logging"
  | `platform-service:${string}`
  | "reachable-by-platform"
  | "peer-services"
  | `database-role:${string}`;

/**
 * An absolute host path whose segments cannot hold `:`, `$` or whitespace, so
 * the path cannot be confused with the grant's separators or expand on the host.
 */
export const HOST_PATH_PATTERN = /^\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/;
export const HOST_PATH_MAX_LENGTH = 255;
/** The device paths a service manifest may map into its container. */
export const DEVICE_PATH_PATTERN = /^\/dev\/[A-Za-z0-9_\-/]+$/;
const DEVICE_PATH_MAX_LENGTH = 255;
const CAPABILITY_NAME_PATTERN = /^[A-Z_]+$/;
/** A PostgreSQL role name that needs no quoting and fits the 63-byte identifier limit. */
export const DATABASE_ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;
/** A PostgreSQL schema name that needs no quoting and fits the 63-byte identifier limit. */
export const DATABASE_SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
/** One privilege a requested database role holds on a schema; the capture is the schema name. */
export const DATABASE_PRIVILEGE_PATTERN = /^(create-schema|use-schema):([a-z][a-z0-9_]{0,62})$/;
/** Above the longest grant, a host path of `HOST_PATH_MAX_LENGTH` characters. */
export const GRANT_ID_MAX_LENGTH = 300;
export const MAX_GRANTS_PER_SERVICE = 64;
/** Total over all services, so an agent record holding the map several times stays within its limit. */
export const MAX_APPROVED_GRANTS = 256;

const BARE_GRANTS: ReadonlySet<string> = new Set([
  "host-network",
  "gpu",
  "privileged",
  "logging",
  "reachable-by-platform",
  "peer-services",
]);

const RESERVED_DATABASE_NAMES: ReadonlySet<string> = new Set([
  "public",
  "tiles",
  "data_manager",
  "drizzle",
  "extensions",
  "information_schema",
  "postgres",
]);

/** The schemas data-manager publishes, each with the copies it swaps in and keeps. */
const DATA_MANAGER_SCHEMA_PATTERN =
  /^(?:osm_search|notable_places|overture_places|ambient_places|overture_embeddings)(?:__staging|__previous)?$/;
const RESERVED_DATABASE_PREFIXES = ["pg_", "ext_", "openmapx_"] as const;

/**
 * Whether a role or schema name belongs to PostgreSQL or to OpenMapX itself,
 * so a service may neither request it nor create it.
 */
export function isReservedDatabaseName(name: string): boolean {
  return (
    RESERVED_DATABASE_NAMES.has(name) ||
    DATA_MANAGER_SCHEMA_PATTERN.test(name) ||
    RESERVED_DATABASE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function isHostPath(path: string): boolean {
  return (
    path.length <= HOST_PATH_MAX_LENGTH &&
    HOST_PATH_PATTERN.test(path) &&
    path
      .split("/")
      .slice(1)
      .every((segment) => segment !== "." && segment !== "..")
  );
}

/** Whether a value is a grant identifier in its only accepted spelling. */
export function isGrantId(value: unknown): value is GrantId {
  if (typeof value !== "string" || value.length > GRANT_ID_MAX_LENGTH) return false;
  if (BARE_GRANTS.has(value)) return true;
  const separator = value.indexOf(":");
  if (separator < 0) return false;
  const kind = value.slice(0, separator);
  const subject = value.slice(separator + 1);
  switch (kind) {
    case "host-path": {
      const mode = subject.slice(-3);
      return (mode === ":ro" || mode === ":rw") && isHostPath(subject.slice(0, -3));
    }
    case "device":
      return subject.length <= DEVICE_PATH_MAX_LENGTH && DEVICE_PATH_PATTERN.test(subject);
    case "capability":
      return CAPABILITY_NAME_PATTERN.test(subject);
    case "platform-service":
      return isComponentId(subject);
    case "database-role":
      return DATABASE_ROLE_NAME_PATTERN.test(subject);
    default:
      return false;
  }
}

export const grantIdSchema = z
  .string()
  .max(GRANT_ID_MAX_LENGTH)
  .refine(isGrantId, "not a grant identifier") as z.ZodType<GrantId>;

/** The distinct grants in code-unit order: the one stored form of a set of grants. */
export function normalizeGrants(grants: readonly GrantId[]): GrantId[] {
  return [...new Set(grants)].sort();
}

/** Approved grants per service id. */
export type ApprovedGrants = Record<string, GrantId[]>;

function isNormalized(grants: readonly GrantId[]): boolean {
  const normalized = normalizeGrants(grants);
  return normalized.length === grants.length && normalized.every((grant, i) => grant === grants[i]);
}

export const approvedGrantsSchema: z.ZodType<ApprovedGrants> = z
  .record(
    componentIdSchema,
    z
      .array(grantIdSchema)
      .max(MAX_GRANTS_PER_SERVICE)
      .refine(isNormalized, "grants must be distinct and sorted"),
  )
  .refine(
    (approved) =>
      Object.values(approved).reduce((total, grants) => total + grants.length, 0) <=
      MAX_APPROVED_GRANTS,
    `at most ${MAX_APPROVED_GRANTS} grants over all services`,
  );
