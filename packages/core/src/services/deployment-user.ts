import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite } from "../release-files";
import {
  assertDeploymentEnvironmentFile,
  readDeploymentUserAssignments,
  readOwnedStateFile,
} from "./deployment";

export { readDeploymentUserAssignments } from "./deployment";

/**
 * The deployment's user: the uid and gid the stack's own containers run as
 * (`user: "${UID}:${GID}"`) and own their files with. Compose reads them from
 * `infra/docker/.env`. A host render writes them there from the checkout's
 * owner when `.env` has no value, so no uid is ever assumed; an explicit value
 * is kept. The operations agent and the fixed CLI it runs only read them (see
 * `readDeploymentUser`).
 */
export interface DeploymentUser {
  uid: number;
  gid: number;
  /** Which of the two this call wrote into `.env`. */
  derived: Array<"UID" | "GID">;
}

const MAX_ENV_BYTES = 1024 * 1024;

function envPath(infraDir: string): string {
  return join(infraDir, ".env");
}

/** The checkout `infra/docker` belongs to. */
function checkoutRoot(infraDir: string): string {
  return resolve(infraDir, "..", "..");
}

/** The checkout's owner and group: who the deployment's files belong to. */
export function checkoutOwner(infraDir: string): { uid: number; gid: number } {
  const stats = statSync(checkoutRoot(infraDir));
  return { uid: stats.uid, gid: stats.gid };
}

/**
 * Read the deployment's user from `.env`, writing whichever of `UID` and `GID`
 * it lacks from the checkout's owner: the host render's path. Refuses to
 * derive uid 0: a checkout root owns would run the stack's containers as root.
 * `.env` must be the operator's own (see `deploymentEnvironmentFileProblem`);
 * it is replaced atomically and stays 0600. A missing `.env` is created with
 * just these two lines.
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
    "# The deployment's user and group, from the checkout's owner. A render on",
    "# the host writes them when they are missing; an explicit value is kept.",
    ...(derived.includes("UID") ? [`UID=${uid}`] : []),
    ...(derived.includes("GID") ? [`GID=${gid}`] : []),
  ];
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  atomicWrite(path, `${current}${separator}${current === "" ? "" : "\n"}${lines.join("\n")}\n`);
  return { uid, gid, derived };
}

/** What writes a missing UID or GID: a render on the host, as the checkout's owner. */
const HOST_RENDER_COMMAND = "pnpm openmapx compose render";

/** `.env` names no deployment user, and this process may not write one. */
export class DeploymentUserError extends Error {
  override name = "DeploymentUserError";
}

/**
 * Why `.env`'s UID and GID can't be read without writing them: which it lacks,
 * and the host render that writes them. Null when it sets both.
 */
export function missingDeploymentUserProblem(assigned: {
  uid?: number;
  gid?: number;
}): string | null {
  const missing = [
    ...(assigned.uid === undefined ? ["UID"] : []),
    ...(assigned.gid === undefined ? ["GID"] : []),
  ];
  if (missing.length === 0) return null;
  return `infra/docker/.env sets no ${missing.join(" or ")}, and the operations agent does not write .env: run \`${HOST_RENDER_COMMAND}\` on the host, as the checkout's owner, which writes UID and GID from that owner.`;
}

/**
 * Read the deployment's user from `.env` without writing it: the operations
 * agent's path, for its startup, its commits and its fixed CLI's renders.
 * `.env` must be the operator's own; one that sets no UID or GID is refused
 * with the host render that writes them, and is never created or changed.
 */
export function readDeploymentUser(infraDir: string): { uid: number; gid: number } {
  assertDeploymentEnvironmentFile(envPath(infraDir));
  const assigned = readDeploymentUserAssignments(infraDir);
  const problem = missingDeploymentUserProblem(assigned);
  if (problem) throw new DeploymentUserError(problem);
  return { uid: assigned.uid as number, gid: assigned.gid as number };
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
