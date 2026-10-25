import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as c from "./control-authority";
import { advanceRetentionClock } from "./retention-clock";
import { admittedRoot, terminalWithoutEffect } from "./test-fixtures/authority";

let root: string;
const installations: c.ControlInstallation[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-renewable-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await c.provisionControlInstallation(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const installation of installations.splice(0)) c.closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});
function owner() {
  const f = admittedRoot(root);
  installations.push(f.installation);
  return f;
}
it("renews ordinary capacity from an eligible terminal family instead of exhausting lifetime receipts", async () => {
  const f = owner();
  terminalWithoutEffect(f.authority);
  const state = c.installationState(f.installation);
  const count = join(root, "control-private/host-cli/executions/.retention-count");
  const full = { version: 1, sequence: 100000, count: 65536 };
  writeFileSync(count, JSON.stringify(full));
  writeFileSync(count.replace(".retention-count", ".retention-highwater"), JSON.stringify(full)); // Consumed creation reservations at ordinary capacity.
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 96 * 3600_000);
  const api = await import("./index");
  // Before implementation, no collector runs and real fresh admission still
  // fails the old lifetime counter. Do not use a missing export as the RED.
  if ("reconcileControlRetention" in api) {
    let retired = 0;
    for (let n = 0; n < 32 && !retired; n++)
      retired += (await api.reconcileControlRetention(f.installation, { maxFamilies: 1 })).retired;
    expect(retired).toBe(1);
  }
  expect(() => owner()).not.toThrow();
  expect(
    existsSync(join(root, `control-private/host-cli/executions/${f.execution.operationKey}.json`)),
  ).toBe(false);
  expect(state.privateRoot.hasEntries()).toBe(true);
  clock.mockRestore();
}, 60000);
it("rejects old exact roots after durable retirement clock advance and wall-clock rollback across restart", () => {
  const f = owner();
  terminalWithoutEffect(f.authority);
  const original = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  advanceRetentionClock(c.installationState(f.installation), f.execution.deadlineAt);
  clock.mockReturnValue(original);
  const replacement = c.openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["motis", "osrm"],
  });
  installations.push(replacement);
  expect(() => admittedRoot(root)).toThrow(/clock.*recovery|clock.*backward/i);
  const authority = c.restoreAdmittedControlExecution(replacement, f.execution);
  expect(() => c.beginControlEffect(authority)).toThrow(/clock|expired|observation/i);
  expect(() => c.verifyControlEffectSettlement(replacement, f.execution)).not.toThrow();
});
it("does not recreate a missing or rolled-back private clock in a nonempty store", () => {
  const f = owner();
  const path = join(root, "control-private/host-cli/retention-clock.json");
  const old = readFileSync(path);
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  advanceRetentionClock(c.installationState(f.installation), f.execution.deadlineAt);
  writeFileSync(path, old);
  expect(() => owner()).toThrow(/clock.*rollback|clock.*recovery/i);
  rmSync(path);
  expect(() => owner()).toThrow(/clock.*missing|clock.*recovery/i);
});

it("does not reset the expiry floor by reprovisioning an emptied private role store", async () => {
  const f = owner();
  terminalWithoutEffect(f.authority);
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  advanceRetentionClock(c.installationState(f.installation), f.execution.deadlineAt);
  c.closeControlInstallation(f.installation);
  installations.splice(installations.indexOf(f.installation), 1);
  rmSync(join(root, "control-private/host-cli"), { recursive: true });
  await c.provisionControlInstallation(root);
  expect(() => owner()).toThrow(/clock.*missing|clock.*recovery/i);
  expect(existsSync(join(root, "control-private/host-cli/retention-clock.json"))).toBe(false);
});

it("does not retire a young family or a replaced indexed receipt", async () => {
  const f = owner();
  terminalWithoutEffect(f.authority);
  expect(await c.reconcileControlRetention(f.installation, { maxFamilies: 1 })).toEqual({
    retired: 0,
    pending: 1,
  });
  const path = join(root, `control-private/host-cli/executions/${f.execution.operationKey}.json`),
    bytes = readFileSync(path);
  const { renameSync } = await import("node:fs");
  writeFileSync(`${path}.replacement`, bytes, { mode: 0o600 });
  renameSync(`${path}.replacement`, path);
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 96 * 3600_000);
  expect(await c.reconcileControlRetention(f.installation, { maxFamilies: 1 })).toEqual({
    retired: 0,
    pending: 1,
  });
  expect(existsSync(path)).toBe(true);
}, 60000);

it("never creates a new deletion plan for an already absent record or decrements a sibling", async () => {
  const { AnchoredDirectory } = await import("./filesystem"),
    q = await import("./control-retention"),
    { randomUUID } = await import("node:crypto");
  const anchor = new AnchoredDirectory(root),
    directory = anchor.directory("quota-fixture", true);
  try {
    q.writeRetainedRecord(directory, "first.json", "first", true);
    q.writeRetainedRecord(directory, "second.json", "second", true);
    const item = {
      familyId: randomUUID(),
      generation: randomUUID(),
      manifestDigest: "a".repeat(64),
      ordinal: 0,
      name: "first.json",
      inode: directory.fileIdentity("first.json"),
      digest: c.controlDigest("first"),
    };
    q.deleteRetainedRecord(directory, item, () => {});
    expect(() => q.deleteRetainedRecord(directory, item, () => {})).toThrow();
    expect(JSON.parse(directory.read(".retention-count", 4096).toString()).count).toBe(1);
    expect(directory.read("second.json", 4096).toString()).toBe("second");
  } finally {
    directory.close();
    anchor.close();
  }
}, 60000);

it("keeps a family pending when a shared semantic file disappears before its first deletion plan", async () => {
  const { AnchoredDirectory } = await import("./filesystem");
  const f = owner();
  terminalWithoutEffect(f.authority);
  const witness = join(
    root,
    `data/.admin-target-control/executions/host-cli/${f.execution.operationKey}.json`,
  );
  const original = AnchoredDirectory.prototype.write;
  let removed = false;
  vi.spyOn(AnchoredDirectory.prototype, "write").mockImplementation(function (
    this: import("./filesystem").AnchoredDirectory,
    ...args
  ) {
    original.apply(this, args);
    if (args[0] !== "decision.json" || removed) return;
    const payload = JSON.parse(args[1].toString()).payload;
    if (payload?.phase === "final" && payload.semanticClean !== true) {
      rmSync(witness);
      removed = true;
    }
  });
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 96 * 3600_000);
  let retired = 0;
  for (let n = 0; n < 4; n++)
    retired += (await c.reconcileControlRetention(f.installation, { maxFamilies: 1 })).retired;
  expect(removed).toBe(true);
  expect(retired).toBe(0);
  expect(existsSync(join(root, "control-private/host-cli/retention-families/slot-0"))).toBe(true);
}, 60000);
