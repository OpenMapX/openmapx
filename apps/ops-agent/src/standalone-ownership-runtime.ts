import { createHash } from "node:crypto";
import { fsyncSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AnchoredDirectory } from "@openmapx/core/build-artifacts";
import { canonicalJson } from "@openmapx/core/ops";
import {
  acquireIntegrationComponentLock,
  describeIntegrationComponentLock,
  finishIntegrationComponentLock,
  inspectDeclarativeIntegrationDirectory,
  inspectLockedIntegrationComponent,
  inspectOptionalLockedIntegrationComponent,
  releaseIntegrationComponentLock,
  restoreIntegrationComponentLock,
} from "@openmapx/integration-framework/installer";
import type { ArtifactTransferStore } from "./artifact-transfer/store";
import type { OpsExecutionContext, OpsRuntime } from "./runtime";
import type { StandaloneOwnershipRecord } from "./standalone-integration-records";

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const same = (a: { dev: string; ino: string }, b: { dev: string; ino: string }) =>
  a.dev === b.dev && a.ino === b.ino;
export function installStandaloneOwnershipRuntime(
  runtime: OpsRuntime,
  options: { rootDir: string; store: ArtifactTransferStore; now?: () => number },
) {
  const { store, rootDir } = options,
    now = options.now ?? Date.now,
    custom = join(rootDir, "custom_integrations");
  const lockState = (record: StandaloneOwnershipRecord) => ({
    rootDir,
    id: record.integrationId,
    transactionId: record.transactionId,
    identity: record.lockIdentity,
  });
  const workspace = (record: StandaloneOwnershipRecord) => {
    const dir = new AnchoredDirectory(
      join(custom, ".staging", `ownership-${record.transactionId}`),
      undefined,
      true,
    );
    if (!same({ dev: String(dir.stat.dev), ino: String(dir.stat.ino) }, record.workspaceIdentity)) {
      dir.close();
      throw Error("Ownership quarantine changed");
    }
    return dir;
  };
  const target = (record: StandaloneOwnershipRecord, signal: AbortSignal) => {
    try {
      lstatSync(join(custom, record.integrationId));
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
    const value = inspectDeclarativeIntegrationDirectory(
      join(custom, record.integrationId),
      rootDir,
      signal,
    );
    if (
      value.id !== record.integrationId ||
      value.contentDigest !== record.contentDigest ||
      !record.targetIdentity ||
      !same(value.identity, record.targetIdentity)
    )
      throw Error("Integration bytes or identity changed since inspection");
    return value;
  };
  runtime["integration.inventory"] = async (_operation, context) => {
    mkdirSync(custom, { recursive: true });
    const root = new AnchoredDirectory(custom);
    try {
      const entries = [];
      for (const name of root.listBounded(1026).sort()) {
        if (name === ".staging" || name === ".installation-locks") continue;
        const safe = /^[a-z0-9][a-z0-9-]{0,63}$/.test(name),
          integrationId = safe
            ? name
            : `invalid-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
        if (!safe) {
          entries.push({
            integrationId,
            version: null,
            contentDigest: null,
            valid: false,
            denialReason: "Invalid legacy directory name; inspect it on the host.",
          });
          continue;
        }
        let lock: ReturnType<typeof acquireIntegrationComponentLock> | undefined;
        try {
          lock = acquireIntegrationComponentLock({ rootDir, id: name });
          const value = inspectLockedIntegrationComponent(lock, context.signal);
          entries.push({
            integrationId,
            version: value.version,
            contentDigest: value.contentDigest,
            valid: true,
            denialReason: null,
          });
        } catch {
          entries.push({
            integrationId,
            version: null,
            contentDigest: null,
            valid: false,
            denialReason:
              "Unsupported, busy or inconsistent legacy content; inspect its original Activity job or the host.",
          });
        } finally {
          if (lock) releaseIntegrationComponentLock(lock);
        }
      }
      for (const pending of store.standalonePendingInventory()) {
        const index = entries.findIndex((entry) => entry.integrationId === pending.integrationId);
        if (index === -1) entries.push(pending);
        else entries[index] = pending;
      }
      return { entries };
    } finally {
      root.close();
    }
  };
  runtime["integration.inspectOwnership"] = async (operation, context) => {
    const installationId = store.standaloneInstallationId(context);
    try {
      const old = store.readStandaloneOwnership(context, operation.operationId);
      if (canonicalJson(old.inspectionExecution) !== canonicalJson(context.execution))
        throw Error("Ownership inspection replay mismatch");
      const lock = restoreIntegrationComponentLock(lockState(old));
      const current = inspectOptionalLockedIntegrationComponent(lock, context.signal);
      if (
        (current?.contentDigest ?? null) !== old.contentDigest ||
        (current && (!old.targetIdentity || !same(current.identity, old.targetIdentity)))
      )
        throw Error("Ownership changed");
      return {
        allowed: true,
        transactionId: old.transactionId,
        integrationId: old.integrationId,
        contentDigest: old.contentDigest,
        version: old.componentVersion,
        expiresAt: old.expiresAt,
      };
    } catch (error) {
      if (!absent(error)) throw error;
    }
    context.signal.throwIfAborted();
    let lock: ReturnType<typeof acquireIntegrationComponentLock>;
    try {
      lock = acquireIntegrationComponentLock({
        rootDir,
        id: operation.integrationId,
        transactionId: operation.operationId,
      });
    } catch {
      return {
        allowed: false,
        transactionId: operation.operationId,
        integrationId: operation.integrationId,
        reason: "Component is busy; reconcile its original Activity job.",
      };
    }
    let retained = false;
    try {
      const current = inspectOptionalLockedIntegrationComponent(lock, context.signal);
      if ((current?.contentDigest ?? null) !== operation.expectedContentDigest)
        throw Error("Integration changed since inventory; refresh before continuing");
      const root = new AnchoredDirectory(custom),
        staging = root.directory(".staging", true, false);
      let dir: AnchoredDirectory | undefined;
      try {
        mkdirSync(staging.name(`ownership-${operation.operationId}`), { mode: 0o700 });
        fsyncSync(staging.fd);
        dir = staging.directory(`ownership-${operation.operationId}`, false, true);
        const record: StandaloneOwnershipRecord = {
          version: 1,
          installationId,
          transactionId: operation.operationId,
          integrationId: operation.integrationId,
          ownerId: operation.ownerId,
          inspectionExecution: context.execution,
          removeExecution: null,
          contentDigest: current?.contentDigest ?? null,
          componentVersion: current?.version ?? null,
          expiresAt: new Date(Math.min(now() + 600000, context.execution.deadlineAt)).toISOString(),
          targetIdentity: current?.identity ?? null,
          lockIdentity: describeIntegrationComponentLock(lock).identity,
          workspaceIdentity: { dev: String(dir.stat.dev), ino: String(dir.stat.ino) },
          phase: "inspected",
          decision: null,
        };
        // A publication error is ambiguous: keep the exact lock for reconciliation.
        retained = true;
        store.retainStandaloneOwnership(context, record);
        return {
          allowed: true,
          transactionId: record.transactionId,
          integrationId: record.integrationId,
          contentDigest: record.contentDigest,
          version: record.componentVersion,
          expiresAt: record.expiresAt,
        };
      } finally {
        dir?.close();
        staging.close();
        root.close();
      }
    } catch (error) {
      if (retained) throw error;
      return {
        allowed: false,
        transactionId: operation.operationId,
        integrationId: operation.integrationId,
        reason: "Integration content changed or cannot be safely adopted; refresh its inventory.",
      };
    } finally {
      if (!retained) releaseIntegrationComponentLock(lock);
    }
  };
  runtime["integration.remove"] = async (operation, context) => {
    const record = store.readStandaloneOwnership(context, operation.transactionId);
    if (record.contentDigest !== operation.expectedContentDigest || record.decision)
      throw Error("Removal inspection changed or settled");
    const lock = restoreIntegrationComponentLock(lockState(record));
    describeIntegrationComponentLock(lock);
    if (
      record.removeExecution &&
      canonicalJson(record.removeExecution) !== canonicalJson(context.execution)
    )
      throw Error("Removal already belongs to another execution");
    if (!["inspected", "remove_requested", "removed"].includes(record.phase))
      throw Error("Removal transaction is unavailable");
    const dir = workspace(record);
    try {
      if (record.phase !== "removed") {
        if (record.phase === "inspected" && Date.parse(record.expiresAt) <= now())
          throw Error("Ownership inspection expired");
        const current = target(record, context.signal);
        if (current) {
          context.signal.throwIfAborted();
          record.removeExecution = context.execution;
          record.phase = "remove_requested";
          store.retainStandaloneOwnership(context, record);
          renameSync(join(custom, record.integrationId), dir.name("component"));
          fsyncSync(dir.fd);
          const root = new AnchoredDirectory(custom);
          try {
            fsyncSync(root.fd);
          } finally {
            root.close();
          }
        }
        if (record.targetIdentity) {
          const old = inspectDeclarativeIntegrationDirectory(
            dir.name("component"),
            rootDir,
            context.signal,
          );
          if (
            old.contentDigest !== record.contentDigest ||
            !same(old.identity, record.targetIdentity) ||
            target(record, context.signal)
          )
            throw Error("Removal quarantine is not the original component");
        } else {
          if (target(record, context.signal))
            throw Error("Missing integration appeared during removal");
          record.removeExecution = context.execution;
        }
        record.phase = "removed";
        store.retainStandaloneOwnership(context, record);
      }
      return {
        transactionId: record.transactionId,
        integrationId: record.integrationId,
        contentDigest: record.contentDigest,
        outcome: "removed",
      };
    } finally {
      dir.close();
    }
  };
  const installSettle = runtime["integration.settle"];
  runtime["integration.settle"] = async (operation, context) => {
    let record: StandaloneOwnershipRecord;
    try {
      record = store.readStandaloneOwnership(context, operation.transactionId);
    } catch (error) {
      if (absent(error)) return installSettle(operation, context);
      throw error;
    }
    if (
      record.contentDigest !== operation.expectedContentDigest ||
      (record.decision && record.decision !== operation.decision)
    )
      throw Error("Ownership settlement mismatch");
    if (record.phase === "committed" || record.phase === "restored") {
      if ((record.phase === "committed") !== (operation.decision === "commit"))
        throw Error("Ownership already settled differently");
      finishIntegrationComponentLock(lockState(record));
      return {
        transactionId: record.transactionId,
        outcome: record.phase,
        contentDigest: record.contentDigest,
      };
    }
    const lock = restoreIntegrationComponentLock(lockState(record));
    describeIntegrationComponentLock(lock);
    const dir = workspace(record);
    try {
      record.decision = operation.decision;
      if (!record.removeExecution) {
        if (record.targetIdentity && !target(record, context.signal))
          throw Error("Adoption target disappeared");
        if (!record.targetIdentity && target(record, context.signal))
          throw Error("Previously absent integration appeared");
      } else if (!record.targetIdentity) {
        if (target(record, context.signal)) throw Error("Previously absent integration appeared");
      } else if (operation.decision === "restore") {
        record.phase = "restore_requested";
        store.retainStandaloneOwnership(context, record);
        const current = target(record, context.signal);
        if (!current) {
          const old = inspectDeclarativeIntegrationDirectory(
            dir.name("component"),
            rootDir,
            context.signal,
          );
          if (
            !same(old.identity, record.targetIdentity) ||
            old.contentDigest !== record.contentDigest
          )
            throw Error("Original removal backup changed");
          renameSync(dir.name("component"), join(custom, record.integrationId));
          fsyncSync(dir.fd);
          const root = new AnchoredDirectory(custom);
          try {
            fsyncSync(root.fd);
          } finally {
            root.close();
          }
        }
      } else {
        if (target(record, context.signal))
          throw Error("Removal destination was replaced; preserve quarantine");
        if (record.phase !== "commit_requested") {
          const original = inspectDeclarativeIntegrationDirectory(
            dir.name("component"),
            rootDir,
            context.signal,
          );
          if (
            original.contentDigest !== record.contentDigest ||
            !same(original.identity, record.targetIdentity)
          )
            throw Error("Removal backup bytes changed");
        }
        record.phase = "commit_requested";
        store.retainStandaloneOwnership(context, record);
        let child: AnchoredDirectory | null;
        try {
          child = dir.directory("component", false, false);
        } catch (error) {
          if (!absent(error)) throw error;
          child = null;
        }
        if (child) {
          try {
            if (
              !same(
                { dev: String(child.stat.dev), ino: String(child.stat.ino) },
                record.targetIdentity,
              )
            )
              throw Error("Removal quarantine changed");
          } finally {
            child.close();
          }
          rmSync(dir.name("component"), { recursive: true });
          fsyncSync(dir.fd);
        }
      }
      record.phase = operation.decision === "commit" ? "committed" : "restored";
      store.retainStandaloneOwnership(context, record);
      finishIntegrationComponentLock(lockState(record));
      return {
        transactionId: record.transactionId,
        outcome: record.phase,
        contentDigest: record.contentDigest,
      };
    } finally {
      dir.close();
    }
  };
}
