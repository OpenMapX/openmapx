import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  type LeaseRecord,
  leaseStoreDirectory,
  openLeaseStore,
} from "@openmapx/core/build-artifacts";
import { canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import type { Command } from "commander";
import { completeCliCommand } from "../lib/control-context";
import { settleMaintenanceFence } from "../lib/control-resolve";
import { dockerCompose, dockerComposeStream } from "../lib/docker";
import { applyGeneratedHardlinksBeforeStart } from "../lib/hardlinks";
import { leasedHostEffect } from "../lib/host-effect";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";
import {
  assertDatabaseAllowsRollback,
  planRollback,
  readNewestAppliedMigration,
} from "../lib/rollback";

/**
 * The operator exit for the update system: what the agent's store believes is
 * held, and the two host-only ways to end an operation whose outcome is
 * unknown. Every clear and resolve is appended to an audit file in the
 * agent's state and printed.
 */
const LOCKS = {
  leases: () => join(leaseStoreDirectory(repoPaths().infraDir), "leases.lock"),
  writer: () => services.configurationWriterLockPath(repoPaths().infraDir),
  backups: () => services.backupStoreLockPath(repoPaths().infraDir),
} as const;

/**
 * A busy message names an installation lock, or its reclaim guard, by its file;
 * the short name works too. An update receipt's lock is named by its path.
 */
function lockPath(value: string): string {
  const name = value.replace(/\.reclaim$/, "");
  const known = Object.entries(LOCKS).find(
    ([short, path]) => name === short || name === basename(path()),
  );
  if (known) return known[1]();
  if (isAbsolute(name) && /^\..+\.lock$/.test(basename(name))) return name;
  throw new Error(`Unknown lock ${value}`);
}

function store() {
  return openLeaseStore({
    directory: leaseStoreDirectory(repoPaths().infraDir),
    purpose: "host-cli",
  });
}

function audit(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  const path = join(leaseStoreDirectory(repoPaths().infraDir), "control-audit.jsonl");
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  log.info(`control audit: ${line}`);
}

function describe(lease: LeaseRecord): string[] {
  const lines = [
    `${lease.owner.executor} ${lease.ownerKind} ${lease.owner.operationKey} (${lease.state})`,
    `  lease ${lease.leaseId}, since ${new Date(lease.createdAt).toISOString()}`,
    `  targets: ${lease.targets.join(", ")}`,
  ];
  for (const child of lease.children)
    lines.push(
      `  child ${child.kind} ${child.execution.operationKey} → ${child.recipient} (${child.state}${child.settlement ? `, ${child.settlement.outcome}` : ""})`,
    );
  return lines;
}

/** What Docker says runs for the targets, printed before anything is changed. */
async function printLive(targets: readonly string[]): Promise<void> {
  const result = await dockerCompose(["ps", "--all", "--format", "{{.Service}} {{.State}}"]);
  const rows = result.exitCode === 0 ? result.stdout.split("\n").filter(Boolean) : [];
  log.info("Containers of the held targets, as Docker reports them now:");
  for (const target of targets) {
    const row = rows.find((value) => value.split(" ")[0] === target);
    log.info(`  ${target}: ${row ? row.split(" ").slice(1).join(" ") : "no container"}`);
  }
}

function findLease(operationKey: string): LeaseRecord {
  const lease = store()
    .list()
    .find(
      (value) =>
        value.owner.operationKey === operationKey ||
        value.children.some((child) => child.execution.operationKey === operationKey),
    );
  if (!lease) throw new Error(`No lease names operation ${operationKey}`);
  return lease;
}

/**
 * A maintenance root an operator cleared, from the audit file: its fence can
 * still be settled with `control resolve`.
 */
function clearedMaintenance(operationKey: string): LeaseRecord | undefined {
  let lines: string[];
  try {
    lines = readFileSync(
      join(leaseStoreDirectory(repoPaths().infraDir), "control-audit.jsonl"),
      "utf8",
    ).split("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const line of lines.reverse()) {
    if (!line) continue;
    const entry = JSON.parse(line) as { action?: string; lease?: LeaseRecord | null };
    if (
      entry.action === "clear" &&
      entry.lease?.owner.operationKey === operationKey &&
      entry.lease.ownerKind === "configurationMaintenance.prepare"
    )
      return entry.lease;
  }
  return undefined;
}

function hasFence(lease: LeaseRecord): boolean {
  return lease.children.some((child) => child.phase === "configuration-fence");
}

function readJournal(): {
  operationKey: string;
  kind: string;
  state: string;
  errorClass?: string;
}[] {
  try {
    const journal = JSON.parse(
      readFileSync(services.agentStatePaths(repoPaths().infraDir).journal, "utf8"),
    ) as {
      jobs?: {
        operationKey: string;
        operation: { kind: string };
        state: string;
        errorClass?: string;
      }[];
    };
    return (journal.jobs ?? []).map((job) => ({
      operationKey: job.operationKey,
      kind: job.operation.kind,
      state: job.state,
      errorClass: job.errorClass,
    }));
  } catch {
    return [];
  }
}

export function registerControlCommands(program: Command): void {
  const control = program
    .command("control")
    .description("Inspect and end held update-system operations (host only)");

  control
    .command("status")
    .description("Show held leases, unfinished operations and lock holders")
    .action(() => {
      const leases = store().list();
      log.info(leases.length ? "Held leases:" : "No leases are held.");
      for (const lease of leases) for (const line of describe(lease)) log.info(line);
      const open = readJournal().filter(
        (job) =>
          ["queued", "running", "termination_pending"].includes(job.state) ||
          job.errorClass === "recovery_required",
      );
      if (open.length) {
        log.info("Agent operations without a final outcome:");
        for (const job of open)
          log.info(`  ${job.kind} ${job.operationKey} (${job.errorClass ?? job.state})`);
      }
      for (const [name, path] of Object.entries(LOCKS)) {
        const holder = services.readLockHolder(path());
        if (holder)
          log.info(
            `Lock ${name} held by ${holder.purpose} (pid ${holder.pid}, since ${new Date(holder.acquiredAt).toISOString()})`,
          );
      }
      completeCliCommand(0);
    });

  control
    .command("clear")
    .description("Drop the lease of an operation, or a lock, whose holder is gone")
    .option("--op <key>", "Operation key that owns or appears in the lease")
    .option(
      "--lock <name>",
      `Lock to clear: ${Object.keys(LOCKS).join(", ")}, or the name a busy message prints`,
    )
    .action(async (options: { op?: string; lock?: string }) => {
      if (options.lock) {
        const path = lockPath(options.lock);
        const holder = services.clearRecoverableLock(path);
        audit({ action: "clear-lock", lock: options.lock, holder: holder ?? null });
        completeCliCommand(0);
      }
      if (!options.op) throw new Error("Pass --op <key> or --lock <name>");
      const lease = findLease(options.op);
      for (const line of describe(lease)) log.info(line);
      await printLive(lease.targets);
      const removed = await store().update((leases) => {
        const index = leases.findIndex((value) => value.leaseId === lease.leaseId);
        return index < 0 ? undefined : leases.splice(index, 1)[0];
      });
      audit({ action: "clear", operationKey: options.op, lease: removed ?? null });
      if (lease.ownerKind === "configurationMaintenance.prepare" && hasFence(lease))
        log.warn(
          `The data-manager's configuration fence of this maintenance stays prepared and keeps refusing data jobs until \`openmapx control resolve --op ${lease.owner.operationKey} --as committed|failed\` settles it.`,
        );
      completeCliCommand(0);
    });

  control
    .command("resolve")
    .description("Record the outcome of an operation whose outcome is unknown, and release it")
    .requiredOption("--op <key>", "Operation key that owns the lease")
    .requiredOption("--as <outcome>", "committed or failed")
    .action(async (options: { op: string; as: string }) => {
      if (options.as !== "committed" && options.as !== "failed")
        throw new Error("--as must be committed or failed");
      const cleared = store()
        .list()
        .some((value) => value.owner.operationKey === options.op)
        ? undefined
        : clearedMaintenance(options.op);
      const lease = cleared ?? findLease(options.op);
      if (lease.owner.operationKey !== options.op)
        throw new Error("Resolve the operation that owns the lease");
      for (const line of describe(lease)) log.info(line);
      await printLive(lease.targets);
      // A maintenance root also holds the data-manager fence; the same idempotent
      // settle the agent uses releases it.
      if (lease.ownerKind === "configurationMaintenance.prepare")
        await settleMaintenanceFence(lease, options.as);
      const outcome: "committed" | "contained" =
        options.as === "committed" ? "committed" : "contained";
      const evidence = (identity: LeaseRecord["owner"]) => ({
        identity,
        outcome,
        publication: "committed" as const,
        terminalReceiptDigest: createHash("sha256")
          .update(
            canonicalJson({
              kind: "operator-resolution",
              operationKey: options.op,
              as: options.as,
            }),
          )
          .digest("hex"),
      });
      await store().update((leases) => {
        const current = leases.find((value) => value.leaseId === lease.leaseId);
        if (!current) return;
        for (const child of current.children)
          if (child.state !== "settled") {
            child.state = "settled";
            child.settlement = evidence(child.execution);
          }
        current.state = "settled";
        current.settlement = evidence(current.owner);
        leases.splice(leases.indexOf(current), 1);
      });
      audit({ action: "resolve", operationKey: options.op, as: options.as, lease });
      completeCliCommand(0);
    });

  control
    .command("rollback")
    .description(
      "Return to the configuration that was applied with the previous release, and that release",
    )
    .option("--yes", "Roll back; without it the plan is printed and nothing changes")
    .action(async (options: { yes?: boolean }) => {
      const infraDir = repoPaths().infraDir;
      const plan = planRollback(infraDir);
      log.info(
        `Applied configuration: ${plan.currentRevisionId} (release ${plan.current?.manifest.release ?? "none"})`,
      );
      log.info(
        `Configuration applied with the previous release: ${plan.targetRevisionId} (release ${plan.target?.manifest.release ?? "none"})`,
      );
      log.warn(
        "Rolling back returns to that configuration and reverts every configuration change made since: the release selection, the selected services, service configuration and secrets. Services it does not select keep running; stop them with `pnpm openmapx services stop <id>`.",
      );
      assertDatabaseAllowsRollback(plan, await readNewestAppliedMigration());
      if (!options.yes) {
        log.info("Nothing was changed. Run again with --yes to roll back.");
        completeCliCommand(0);
      }
      const { renderComposeForRepo } = await import("./compose");
      const target = services.readGenerationConfiguration(infraDir, plan.targetRevisionId);
      let code: number | null = null;
      let failure: string | undefined;
      try {
        code = await leasedHostEffect("control.rollback", "all", async () => {
          const rendered = await renderComposeForRepo({
            services: target.selectedRoots,
            release: target.release,
            configurationFrom: plan.targetRevisionId,
            expectedCurrentRevisionId: plan.currentRevisionId,
          });
          log.ok(`Rendered the previous configuration again → ${rendered.revisionId}`);
          // Later renders keep the restored selection.
          if (services.readDesiredSelection(infraDir).source !== "env")
            services.writeServiceSelectionFile(infraDir, target.selectedRoots);
          await applyGeneratedHardlinksBeforeStart();
          // The self-update order: the database before its clients, the agent last.
          for (const id of services.selfUpdateServiceOrder(rendered.enabledServiceIds)) {
            const exit = await dockerComposeStream(["up", "-d", "--no-deps", id]);
            if (exit !== 0) {
              log.err(
                `Recreating ${id} failed (exit ${exit}); the services after it were not touched. The previous configuration is applied: fix the cause and run \`pnpm openmapx compose up\` to finish. Do not run rollback again, which would return to the configuration rolled back from.`,
              );
              return exit;
            }
          }
          return 0;
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        audit({
          action: "rollback",
          from: plan.currentRevisionId,
          to: plan.targetRevisionId,
          exitCode: code,
          ...(failure ? { error: failure } : {}),
        });
      }
      completeCliCommand(code);
    });
}
