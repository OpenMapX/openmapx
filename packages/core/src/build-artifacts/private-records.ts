/** Each role's private control records: its installation, the directory only
 * it writes, and plain bounded records read back with schema checks. */
import { fsyncSync, realpathSync, statfsSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalJson } from "../ops/canonical-json";
import { parseControlRootOperationKey } from "../ops/control-root-key";
import type { ControlIssuer } from "../ops/execution-identity";
import { type ControlInstallation, type InstallationState, targetSchema } from "./control-records";
import { AnchoredDirectory, identity } from "./filesystem";
import {
  type LeaseBackend,
  leaseStoreDirectory,
  localLeaseBackend,
  openLeaseStore,
} from "./lease-store";
import { localCredentialTemplateFileDigest } from "./local-credential-template";

export const CONTROL_ROLES = ["ops-agent", "data-manager", "host-cli"] as const;
const PRIVATE_RECORD_BYTES = 131072;
/** Where a role keeps its private control records: its own state directory. */
export function controlPrivateRoot(infraDir: string, role: ControlIssuer): string {
  return join(infraDir, "state", role, "control");
}
/** Data-manager's private records, as its container mounts them. */
export const DATA_MANAGER_CONTAINER_PRIVATE_ROOT = "/var/lib/openmapx/control";
/** Creates each role's private record directory; render and host commands call it. */
export function provisionControlDirectories(infraDir: string): void {
  const infra = new AnchoredDirectory(infraDir);
  try {
    const state = infra.directory("state", true);
    try {
      for (const role of CONTROL_ROLES) {
        const roleRoot = state.directory(role, true);
        try {
          roleRoot.directory("control", true, true).close();
        } finally {
          roleRoot.close();
        }
      }
    } finally {
      state.close();
    }
  } finally {
    infra.close();
  }
}
const installations = new WeakMap<object, InstallationState>();
/** Registers an installation another opener built, such as a fixed child's. */
export function registerControlInstallation(state: InstallationState): void {
  installations.set(state.installation, state);
}
/** The agent's own lease store, as its processes and the host CLI see it. */
export function agentStoreLeases(infraDir: string, role: ControlIssuer): LeaseBackend {
  return localLeaseBackend(
    openLeaseStore({ directory: leaseStoreDirectory(infraDir), purpose: role }),
  );
}
export function installationState(value: ControlInstallation): InstallationState {
  const state = installations.get(value);
  if (!state) throw Error("Unverified control installation");
  state.privateRoot.check();
  return state;
}
/** Who wrote a control record: a fixed child's id, or the role itself. */
export function controlIdentity(installation: ControlInstallation): string {
  return installationState(installation).fixedChildId ?? installation.role;
}
/** Called only at fixed host/service startup; infraDir is the configured installation, never a request field. */
export function openControlInstallation(options: {
  infraDir: string;
  role: ControlIssuer;
  serviceIds?: readonly string[];
  container?: boolean;
  /** Data-manager and the host CLI pass the agent's routes; others use its store. */
  leases?: LeaseBackend;
}): ControlInstallation {
  if (options.serviceIds?.length) targetSchema.parse([...new Set(options.serviceIds)].sort());
  const container = options.container === true && options.role === "data-manager";
  let privateRoot: AnchoredDirectory | undefined;
  try {
    privateRoot = new AnchoredDirectory(
      container
        ? DATA_MANAGER_CONTAINER_PRIVATE_ROOT
        : controlPrivateRoot(options.infraDir, options.role),
      undefined,
      true,
    );
    const dataRoot = container ? "/data" : join(options.infraDir, "data");
    const privateRelative = relative(realpathSync(dataRoot), realpathSync(privateRoot.path));
    if (!privateRelative || (!privateRelative.startsWith("../") && privateRelative !== ".."))
      throw Error("Role recovery material is inside the shared data mount");
    const data = new AnchoredDirectory(dataRoot);
    try {
      if (
        identity(data.stat).dev === identity(privateRoot.stat).dev &&
        identity(data.stat).ino === identity(privateRoot.stat).ino
      )
        throw Error("Role recovery material must be outside shared data");
    } finally {
      data.close();
    }
    const installation = Object.freeze({ role: options.role }) as ControlInstallation;
    installations.set(installation, {
      installation,
      privateRoot,
      dataRoot,
      registeredTargets: new Set(options.serviceIds ?? []),
      leases: options.leases ?? agentStoreLeases(options.infraDir, options.role),
    });
    privateRoot = undefined;
    return installation;
  } finally {
    privateRoot?.close();
  }
}
export function closeControlInstallation(installation: ControlInstallation) {
  const s = installationState(installation);
  s.privateRoot.close();
  installations.delete(installation);
}
export function writePrivateRecord(
  state: InstallationState,
  namespace: string,
  name: string,
  value: unknown,
  exclusive = false,
) {
  const dir = state.privateRoot.directory(namespace, true, true);
  try {
    const bytes = canonicalJson(value);
    if (Buffer.byteLength(bytes) > PRIVATE_RECORD_BYTES) throw Error("Private receipt limit");
    if (
      ![
        "executions",
        "effects",
        "effect-started",
        "observations",
        "spawns",
        "spawn-started",
        "configuration-maintenance",
        "maintenance",
        "catalog-commits",
      ].includes(namespace)
    )
      throw Error("Unknown fixed authority namespace");
    dir.write(name, bytes, exclusive);
  } finally {
    dir.close();
  }
}
export function assertFreshControlRoot(key: string, requestedDeadlineAt: number | undefined): void {
  const parsed = parseControlRootOperationKey(key);
  if (requestedDeadlineAt !== parsed.notAfter || parsed.notAfter - Date.now() > 7 * 24 * 3600_000)
    throw Error("A timed control root with its exact deadline is required");
  // An expired root is refused whether or not its records were already pruned.
  if (parsed.notAfter <= Date.now()) throw Error("Expired control root");
}
/** Refuses new control work, before any effect, when the role's private
 * state filesystem has less than 64 MiB free. */
export function assertControlStorageAvailable(installation: ControlInstallation): void {
  const { bavail, bsize } = statfsSync(installationState(installation).privateRoot.anchor);
  if (bavail * bsize < 64 * 1024 * 1024)
    throw Error("Control state filesystem is nearly full; free space before retrying");
}
export function controlInstallationDataRoot(installation: ControlInstallation): string {
  return installationState(installation).dataRoot;
}
/** Fixed agent registry refresh after a repository publication/removal. This
 * local admission cache is populated from the literal trusted service loader,
 * never an operation's requested IDs. Retained roots keep their recorded targets. */
export function replaceControlRegisteredServiceIds(
  installation: ControlInstallation,
  serviceIds: readonly string[],
): void {
  const state = installationState(installation);
  if (installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Agent registry refresh required");
  state.registeredTargets = new Set(targetSchema.parse([...new Set(serviceIds)].sort()));
}
export function controlRegisteredServiceIds(installation: ControlInstallation): string[] {
  return [...installationState(installation).registeredTargets].sort();
}
export function readPrivateRecord(
  state: InstallationState,
  namespace: string,
  name: string,
  max: number = PRIVATE_RECORD_BYTES,
): unknown {
  const dir = state.privateRoot.directory(namespace);
  try {
    return JSON.parse(dir.read(name, max).toString("utf8"));
  } finally {
    dir.close();
  }
}
export const CONTROL_RECOVERY_INSTRUCTIONS =
  "Run openmapx compose render on the installation host to provision control trust. For missing or conflicting retained records: stop all relevant writers and helpers, inspect the original private receipts and publication state, and repair only the exact owned record; never delete locks by age.";
/** Availability is not authority. An unavailable signer leaves inspection/recovery HTTP routes intact. */
export function loadControlStartup(options: Parameters<typeof openControlInstallation>[0]): {
  installation?: ControlInstallation;
  reason?: string;
} {
  try {
    return { installation: openControlInstallation(options) };
  } catch {
    return { reason: CONTROL_RECOVERY_INSTRUCTIONS };
  }
}
/** Opaque local file version, never a public hash of a credential value. */
export function localFeedCredentialTemplateDigest(
  installation: ControlInstallation,
  operation: unknown,
  contents?: string,
) {
  return localCredentialTemplateFileDigest(installationState(installation), operation, contents);
}
