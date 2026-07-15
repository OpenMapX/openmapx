import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type MotisSlot = "A" | "B";

export interface MotisSlotRecord {
  schemaVersion: 1;
  activeSlot: MotisSlot;
  previousHealthySlot?: MotisSlot;
  datasetEpoch?: string;
  manifestHash?: string;
  imageDigest?: string;
  activatedAt?: string;
}

export interface MotisSlotLayout {
  root: string;
  slots: Record<MotisSlot, string>;
  liveAlias: string;
  stagingAlias: string;
  statePath: string;
  record: MotisSlotRecord;
}

const other = (slot: MotisSlot): MotisSlot => (slot === "A" ? "B" : "A");

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(temporary, path);
}

function readRecord(path: string): MotisSlotRecord | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as MotisSlotRecord;
  if (parsed.schemaVersion !== 1 || !["A", "B"].includes(parsed.activeSlot)) {
    throw new Error(`malformed MOTIS slot state at ${path}`);
  }
  return parsed;
}

function replaceAlias(alias: string, target: string): void {
  const temporary = `${alias}.tmp-${process.pid}`;
  rmSync(temporary, { force: true, recursive: true });
  symlinkSync(relative(dirname(alias), target), temporary, "dir");
  renameSync(temporary, alias);
}

function migrateDirectory(alias: string, target: string): void {
  if (!existsSync(alias) || lstatSync(alias).isSymbolicLink()) return;
  if (existsSync(target) && lstatSync(target).isDirectory()) {
    const entries = readFileSafeDirectory(target);
    if (entries > 0) throw new Error(`cannot migrate ${alias}: target ${target} is not empty`);
    rmSync(target, { recursive: true, force: true });
  }
  renameSync(alias, target);
}

function readFileSafeDirectory(path: string): number {
  try {
    return readdirSync(path).length;
  } catch {
    return 0;
  }
}

export function ensureMotisSlotLayout(dataDir: string): MotisSlotLayout {
  const root = join(dataDir, "motis");
  const slots = { A: join(root, "slots", "A"), B: join(root, "slots", "B") } as const;
  const liveAlias = join(root, "live");
  const stagingAlias = join(root, "staging");
  const statePath = join(root, "slot-state.json");
  mkdirSync(join(root, "slots"), { recursive: true });
  mkdirSync(slots.A, { recursive: true });
  mkdirSync(slots.B, { recursive: true });
  const existing = readRecord(statePath);
  const record: MotisSlotRecord = existing ?? { schemaVersion: 1, activeSlot: "A" };
  migrateDirectory(liveAlias, slots[record.activeSlot]);
  migrateDirectory(stagingAlias, slots[other(record.activeSlot)]);
  replaceAlias(liveAlias, slots[record.activeSlot]);
  replaceAlias(stagingAlias, slots[other(record.activeSlot)]);
  if (!existing) atomicJson(statePath, record);
  return { root, slots: { ...slots }, liveAlias, stagingAlias, statePath, record };
}

export function flipMotisSlotAliases(layout: MotisSlotLayout, activeSlot: MotisSlot): void {
  replaceAlias(layout.liveAlias, layout.slots[activeSlot]);
  replaceAlias(layout.stagingAlias, layout.slots[other(activeSlot)]);
}

export function commitMotisSlotActivation(
  layout: MotisSlotLayout,
  next: {
    activeSlot: MotisSlot;
    datasetEpoch: string;
    manifestHash: string;
    imageDigest?: string;
    activatedAt: string;
  },
): MotisSlotRecord {
  const record: MotisSlotRecord = {
    schemaVersion: 1,
    activeSlot: next.activeSlot,
    previousHealthySlot: layout.record.activeSlot,
    datasetEpoch: next.datasetEpoch,
    manifestHash: next.manifestHash,
    imageDigest: next.imageDigest,
    activatedAt: next.activatedAt,
  };
  atomicJson(layout.statePath, record);
  layout.record = record;
  return record;
}

export function aliasSlot(layout: MotisSlotLayout, alias: "live" | "staging"): MotisSlot | null {
  const path = alias === "live" ? layout.liveAlias : layout.stagingAlias;
  if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) return null;
  const target = resolve(dirname(path), readlinkSync(path));
  return (
    (Object.entries(layout.slots).find(([, slotPath]) => resolve(slotPath) === target)?.[0] as
      | MotisSlot
      | undefined) ?? null
  );
}

export function reconcileMotisSlotLayout(layout: MotisSlotLayout): MotisSlotRecord {
  const live = aliasSlot(layout, "live");
  if (live !== layout.record.activeSlot) {
    // Recorded state wins: it represents the last post-probe healthy slot.
    flipMotisSlotAliases(layout, layout.record.activeSlot);
  }
  return layout.record;
}
