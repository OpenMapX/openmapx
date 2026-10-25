import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite } from "../release-files";
import { assertDeploymentEnvironmentFile, readOwnedStateFile } from "./deployment";

/**
 * The deployment's user: the uid and gid the stack's own containers run as
 * (`user: "${UID}:${GID}"`) and own their files with. Compose reads them from
 * `infra/docker/.env`. Every render, the host's and the operations agent's,
 * writes them there from the checkout's owner when `.env` has no value, so no
 * uid is ever assumed. An explicit value is kept.
 */
export interface DeploymentUser {
  uid: number;
  gid: number;
  /** Which of the two this call wrote into `.env`. */
  derived: Array<"UID" | "GID">;
}

const MAX_ENV_BYTES = 1024 * 1024;
const ASSIGNMENT = /^\s*(?:export\s+)?(UID|GID)\s*=\s*(.*?)\s*$/;

function envPath(infraDir: string): string {
  return join(infraDir, ".env");
}

/** The checkout `infra/docker` belongs to. */
function checkoutRoot(infraDir: string): string {
  return resolve(infraDir, "..", "..");
}

function parseId(name: "UID" | "GID", raw: string, source: string): number {
  const value = raw.replace(/^(["'])(.*)\1$/, "$2");
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} in ${source} must be a numeric id, not "${raw}"`);
  }
  return Number(value);
}

/** The explicit `UID`/`GID` assignments in `.env`; commented lines don't count. */
export function readDeploymentUserAssignments(infraDir: string): {
  uid?: number;
  gid?: number;
} {
  const path = envPath(infraDir);
  const bytes = readOwnedStateFile(path, MAX_ENV_BYTES);
  if (bytes === null) return {};
  const found: { uid?: number; gid?: number } = {};
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    const id = parseId(match[1] as "UID" | "GID", match[2] as string, path);
    if (match[1] === "UID") found.uid = id;
    else found.gid = id;
  }
  return found;
}

/** The checkout's owner and group: who the deployment's files belong to. */
export function checkoutOwner(infraDir: string): { uid: number; gid: number } {
  const stats = statSync(checkoutRoot(infraDir));
  return { uid: stats.uid, gid: stats.gid };
}

/**
 * Read the deployment's user from `.env`, writing whichever of `UID` and `GID`
 * it lacks from the checkout's owner. Refuses to derive uid 0: a checkout root
 * owns would run the stack's containers as root. `.env` must be the operator's
 * own (see `deploymentEnvironmentFileProblem`); it is replaced atomically and
 * stays 0600. A missing `.env` is created with just these two lines.
 */
export function ensureDeploymentUser(infraDir: string): DeploymentUser {
  const path = envPath(infraDir);
  assertDeploymentEnvironmentFile(path);
  const explicit = readDeploymentUserAssignments(infraDir);
  if (explicit.uid !== undefined && explicit.gid !== undefined) {
    return { uid: explicit.uid, gid: explicit.gid, derived: [] };
  }
  const owner = checkoutOwner(infraDir);
  const derived: DeploymentUser["derived"] = [];
  if (explicit.uid === undefined) {
    if (owner.uid === 0) {
      throw new Error(
        `The checkout ${checkoutRoot(infraDir)} is owned by root, so the deployment's user cannot be taken from it: set UID and GID in ${path} to the account that runs the stack`,
      );
    }
    derived.push("UID");
  }
  if (explicit.gid === undefined) derived.push("GID");
  const uid = explicit.uid ?? owner.uid;
  const gid = explicit.gid ?? owner.gid;
  const current = readOwnedStateFile(path, MAX_ENV_BYTES)?.toString("utf8") ?? "";
  const lines = [
    "# The deployment's user and group, from the checkout's owner. Every render",
    "# writes them when they are missing; an explicit value is kept.",
    ...(derived.includes("UID") ? [`UID=${uid}`] : []),
    ...(derived.includes("GID") ? [`GID=${gid}`] : []),
  ];
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  atomicWrite(path, `${current}${separator}${current === "" ? "" : "\n"}${lines.join("\n")}\n`);
  return { uid, gid, derived };
}

/**
 * Refuse to write the deployment's files as anyone but its user: its
 * containers could not read secrets this process creates, nor use the state
 * directories it makes.
 */
export function assertRunningAsDeploymentUser(user: { uid: number }, what = "Rendering"): void {
  const uid = process.geteuid?.();
  if (uid === undefined || uid === user.uid) return;
  throw new Error(
    `${what} runs as uid ${uid}, but the deployment's user (UID in infra/docker/.env) is ${user.uid}: run it as that user, or the stack's containers cannot read what it writes`,
  );
}
