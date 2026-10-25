/** Fixed, role-local receipt ownership and preallocated per-origin retirement cells. */
import { createHash, randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync } from "node:fs";
import { z } from "zod";
import type { ControlExecutionOrigin } from "../ops/control-root-key";
import type {
  ControlIssuer,
  ExecutionRef,
  RetainedParentExecution,
} from "../ops/execution-identity";
import { canonicalJson } from "../ops/fingerprint";
import {
  controlDigest,
  controlOriginSchema,
  type InstallationState,
  signControl,
  verifyControl,
} from "./control-records";
import {
  deleteRetainedRecord,
  finishRetainedDeletion,
  CONTROL_RETENTION_LIMITS as LIMITS,
} from "./control-retention";
import { AnchoredDirectory, type FileIdentity, identity, sameInode } from "./filesystem";
import { advanceRetentionClock, readRetentionClock } from "./retention-clock";

const ROLES = ["ops-agent", "data-manager", "host-cli"] as const;
const PRIVATE = new Set([
  "executions",
  "children",
  "child-keys",
  "effects",
  "effect-started",
  "observations",
  "leases",
  "execution-leases",
  "attempts",
  "adoptions",
  "parent-attempts",
  "parent-adoptions",
  "execution-parents",
  "execution-lifecycle",
  "lifecycle-observations",
  "spawns",
  "spawn-started",
  "prepared",
  "execution-adoptions",
]);
const SHARED = new Set([
  "execution",
  "lease-owner",
  "lease-grants",
  "lease-children",
  "lease-directory",
  "history-slot",
]);
const originSchema = controlOriginSchema;
const identitySchema = z.strictObject({
  dev: z.string().regex(/^\d+$/),
  ino: z.string().regex(/^\d+$/),
});
const sharedIdentitySchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  origin: originSchema,
  familyId: z.uuid(),
  generation: z.uuid(),
  dataRootIdentity: identitySchema,
  sharedIdentity: identitySchema,
});
type SharedIdentity = z.infer<typeof sharedIdentitySchema>;
type Phase = "active" | "prepared" | "ready" | "committed" | "clean" | "final" | "released";
export interface FamilyRecord {
  scope: "private" | "shared";
  namespace: string;
  name: string;
  container: string;
  digest: string;
  inode: FileIdentity;
  ordinal: number;
  state: "reserved" | "prepared" | "written";
  counted: boolean;
  directory: boolean;
  generation?: string;
}
interface ExecutionFact {
  execution: ExecutionRef;
  verifier: string;
  receiptDigest: string;
  terminalDigest?: string;
  terminalAt?: number;
  known: boolean;
  fixedChildId?: string;
  requiresJournal?: boolean;
  journalContained?: boolean;
}
interface IntentFact {
  id: string;
  childDigest: string;
  recipient: ControlIssuer;
}
interface LeaseFact {
  id: string;
  certificateDigest: string;
  ownerRole: ControlIssuer;
  released: boolean;
}
interface ApiDependency {
  parent: Extract<RetainedParentExecution, { issuer: "api" }>;
  operationKey: string;
  fingerprint: string;
}
interface Progress {
  version: 1;
  familyId: string;
  generation: string;
  sequence: number;
  phase: Phase;
  records: number;
  sharedRecords: number;
  metadataBytes: number;
  executions: Record<string, ExecutionFact>;
  intents: Record<string, IntentFact>;
  leases: Record<string, LeaseFact>;
  participants: ControlIssuer[];
  terminalAt: number;
  api?: ApiDependency;
  apiAck?: { terminalDigest: string; proofDigest: string };
  cursor: number;
  sharedCursor: number;
  manifestDigest?: string;
  lastDone?: {
    namespace: string;
    ordinal: number;
    name: string;
    digest: string;
    inode: FileIdentity;
  };
  sharedTransaction?: { ordinal: number; phase: "planned" | "unlinked"; record: FamilyRecord };
  sharedRelease?: boolean;
  journalCleanupPlanned?: boolean;
  journalClean?: boolean;
  lastError?: string;
}
interface Candidate {
  version: 1;
  installationId: string;
  familyId: string;
  generation: string;
  role: ControlIssuer;
  originDigest: string;
  terminalAt: number;
  terminalSequenceDigest: string;
  executionReceiptDigests: Record<string, string>;
  localRecordSetDigest: string;
  sharedRecordSetDigest: string;
  leaseDigests: Record<string, string>;
  intentDigests: Record<string, string>;
}
const apiCopySchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  familyId: z.uuid(),
  generation: z.uuid(),
  originDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operationKey: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  terminalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  proofDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
function apiCopy(f: Family, p: Progress) {
  const raw = json<unknown>(f.shared, "api-ack.json", 4096);
  if (raw === null) return null;
  const value = verifyControl(
    f.state.publicKeys[f.meta.origin.issuer],
    "openmapx-retention-api-copy-v1",
    raw,
    apiCopySchema,
  );
  sameFamily(f, value);
  if (
    value.installationId !== f.meta.installationId ||
    !p.api ||
    value.parentDigest !== controlDigest(p.api.parent) ||
    value.operationKey !== p.api.operationKey ||
    value.fingerprint !== p.api.fingerprint
  )
    throw Error("Invalid API retirement acknowledgement");
  return value;
}
interface Manifest {
  version: 1;
  installationId: string;
  origin: ControlExecutionOrigin;
  familyId: string;
  generation: string;
  sequence: number;
  terminalAt: number;
  terminalSequenceDigest: string;
  participants: string[];
  executionReceiptDigests: Record<string, string>;
  sharedRecordSetDigest: string;
  localRecordSetDigests: Record<string, string>;
}
interface Decision {
  version: 1;
  familyId: string;
  generation: string;
  phase: "active" | "prepared" | "committed" | "final";
  manifestDigest?: string;
  readyDigests?: Record<string, string>;
  cleanDigests?: Record<string, string>;
  sequence: number;
}
interface Ack {
  version: 1;
  installationId: string;
  familyId: string;
  generation: string;
  originDigest: string;
  manifestDigest: string;
  role: ControlIssuer;
  phase: "ready" | "clean" | "released";
  terminalSequenceDigest: string;
  recordSetDigest: string;
  proofCopyDigest: string;
  sequence: number;
}
interface Family {
  state: InstallationState;
  root: AnchoredDirectory;
  slots: AnchoredDirectory;
  slot: AnchoredDirectory;
  sharedRoot: AnchoredDirectory;
  shared: AnchoredDirectory;
  meta: SharedIdentity;
  name: string;
  slotIdentity: FileIdentity;
  slotGeneration: string;
  originHash: string;
  sharedGone?: boolean;
  close(): void;
}
const DIGEST = /^[a-f0-9]{64}$/;
const safeName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const slotName = /^slot-\d{1,4}$/;
function missing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === "ENOENT";
}
function cell(
  dir: AnchoredDirectory,
  name: string,
  value: unknown,
  maximum: number,
  exclusive = false,
) {
  const bytes = canonicalJson(value);
  if (Buffer.byteLength(bytes) > maximum)
    throw Error("Reserved retention workspace capacity exceeded");
  dir.write(name, bytes + " ".repeat(maximum - Buffer.byteLength(bytes)), exclusive);
}
function json<T>(dir: AnchoredDirectory, name: string, max = 131072): T {
  return JSON.parse(dir.read(name, max).toString("utf8")) as T;
}
function signed<T>(state: InstallationState, domain: string, value: T) {
  return signControl(state.privateKey, domain, value);
}
function verified<T>(
  state: InstallationState,
  role: ControlIssuer,
  domain: string,
  raw: unknown,
): T {
  return verifyControl(state.publicKeys[role], domain, raw, z.unknown()) as T;
}
function originHash(origin: ControlExecutionOrigin) {
  return controlDigest(origin);
}
function tuple(e: FamilyRecord): unknown[] {
  return [
    e.scope === "private" ? "p" : "s",
    e.namespace,
    e.name,
    e.container,
    e.digest,
    e.inode.dev,
    e.inode.ino,
    e.ordinal,
    e.state,
    e.counted ? 1 : 0,
    e.directory ? 1 : 0,
    e.generation ?? "",
  ];
}
function entry(v: unknown): FamilyRecord {
  if (
    !Array.isArray(v) ||
    v.length !== 12 ||
    !["p", "s"].includes(v[0]) ||
    !safeName.test(v[2]) ||
    !DIGEST.test(v[4]) ||
    !Number.isSafeInteger(v[7]) ||
    !["reserved", "prepared", "written"].includes(v[8])
  )
    throw Error("Corrupt retention index entry");
  const e: FamilyRecord = {
    scope: v[0] === "p" ? "private" : "shared",
    namespace: v[1],
    name: v[2],
    container: v[3],
    digest: v[4],
    inode: identitySchema.parse({ dev: v[5], ino: v[6] }),
    ordinal: v[7],
    state: v[8],
    counted: v[9] === 1,
    directory: v[10] === 1,
    ...(v[11] ? { generation: z.uuid().parse(v[11]) } : {}),
  };
  if (!(e.scope === "private" ? PRIVATE : SHARED).has(e.namespace))
    throw Error("Unknown fixed retention namespace");
  return e;
}
function readProgress(f: Family): Progress {
  const p = json<Progress>(f.slot, "progress.json");
  if (
    p.version !== 1 ||
    p.familyId !== f.meta.familyId ||
    p.generation !== f.meta.generation ||
    !Number.isSafeInteger(p.sequence) ||
    p.records > LIMITS.recordsPerFamily ||
    !Number.isSafeInteger(p.sharedRecords) ||
    p.sharedRecords < 0 ||
    p.sharedRecords > 2048 ||
    !Number.isSafeInteger(p.metadataBytes) ||
    p.metadataBytes > LIMITS.familyMetadataBytes ||
    Object.keys(p.executions).length > LIMITS.executionsPerFamily ||
    Object.keys(p.intents).length > LIMITS.intentsPerFamily ||
    p.participants.some((r) => !ROLES.includes(r))
  )
    throw Error("Retention family progress identity/capacity mismatch");
  const prior = json<{ sequence: number; digest: string }>(f.slot, "progress-highwater.json", 1024);
  if (
    p.sequence < prior.sequence ||
    (p.sequence === prior.sequence && controlDigest(p) !== prior.digest)
  )
    throw Error("Retention family progress rollback");
  return p;
}
function progress(f: Family, p: Progress, reserveAdmission = false) {
  if (json<Progress>(f.slot, "progress.json").sequence !== p.sequence)
    throw Error("Family progress compare-and-swap conflict");
  if (p.sequence >= Number.MAX_SAFE_INTEGER) throw Error("Family sequence exhausted");
  // Reserve space for retirement transactions and post-effect timestamps.
  // Ordinary admission may never consume the collector's last 8KiB.
  if (reserveAdmission && p.phase === "active" && Buffer.byteLength(canonicalJson(p)) > 120 * 1024)
    throw Error("Family progress capacity exhausted before exposure");
  p.sequence++;
  cell(f.slot, "progress.json", p, 131072);
  cell(f.slot, "progress-highwater.json", { sequence: p.sequence, digest: controlDigest(p) }, 1024);
}
function guard<T>(dir: AnchoredDirectory, name: string, run: () => T): T {
  mkdirSync(dir.name(name), { mode: 0o700 });
  fsyncSync(dir.fd);
  const held = dir.directory(name),
    expected = identity(held.stat);
  try {
    return run();
  } finally {
    held.close();
    dir.removeDirectory(name, expected);
  }
}
function decision(f: Family): Decision {
  const value = verified<Decision>(
    f.state,
    f.meta.origin.issuer,
    "openmapx-retention-decision-v1",
    json(f.shared, "decision.json", 8192),
  );
  if (
    value.version !== 1 ||
    value.familyId !== f.meta.familyId ||
    value.generation !== f.meta.generation ||
    !["active", "prepared", "committed", "final"].includes(value.phase)
  )
    throw Error("Retention decision identity mismatch");
  return value;
}
function writeDecision(f: Family, value: Decision) {
  if (f.state.fixedChildId || f.state.installation.role !== f.meta.origin.issuer)
    throw Error("Only the origin coordinator may publish a retirement decision");
  cell(f.shared, "decision.json", signed(f.state, "openmapx-retention-decision-v1", value), 8192);
}
function checkLocalIdentity(f: Family) {
  f.slot.check();
  f.slots.check();
  if (!sameInode(identity(f.slot.stat), f.slotIdentity)) throw Error("Replaced family slot inode");
  const local = json<{ familyId: string; generation: string; slotGeneration: string }>(
    f.slot,
    "identity.json",
    2048,
  );
  if (
    local.familyId !== f.meta.familyId ||
    local.generation !== f.meta.generation ||
    local.slotGeneration !== f.slotGeneration
  )
    throw Error("Reused family slot generation");
}
function openFamily(state: InstallationState, origin: ControlExecutionOrigin): Family {
  const hash = originHash(origin),
    opened: AnchoredDirectory[] = [];
  const own = (directory: AnchoredDirectory) => {
    opened.push(directory);
    return directory;
  };
  const close = () => {
    for (const directory of [...opened].reverse()) directory.close();
  };
  try {
    const locations = own(state.privateRoot.directory("retention-locations"));
    const local = json<{
      name: string;
      inode: FileIdentity;
      slotGeneration: string;
      identity: unknown;
    }>(locations, `${hash}.json`, 4096);
    if (!slotName.test(local.name)) throw Error("Invalid family slot name");
    const meta = verifyControl(
      state.publicKeys[origin.issuer],
      "openmapx-retention-family-v1",
      local.identity,
      sharedIdentitySchema,
    );
    if (
      controlDigest(meta.origin) !== hash ||
      meta.installationId !== state.installation.installationId
    )
      throw Error("Foreign retained origin");
    const slots = own(state.privateRoot.directory("retention-families")),
      slot = own(slots.directory(local.name)),
      root = own(new AnchoredDirectory(state.dataRoot)),
      control = own(root.directory(".admin-target-control")),
      sharedRoot = own(control.directory("retention-families"));
    if (!sameInode(identity(root.stat), meta.dataRootIdentity))
      throw Error("Family physical data root replaced");
    let shared: AnchoredDirectory,
      sharedGone = false;
    try {
      shared = own(sharedRoot.directory(hash));
    } catch (error) {
      const p = json<Progress>(slot, "progress.json");
      if (!missing(error) || p.phase !== "released") throw error;
      const final = verified<Decision & { semanticClean?: boolean }>(
        state,
        origin.issuer,
        "openmapx-retention-decision-v1",
        json(slot, "final.json", 8192),
      );
      if (
        final.phase !== "final" ||
        !final.semanticClean ||
        final.familyId !== meta.familyId ||
        final.generation !== meta.generation
      )
        throw Error("Missing private final retirement proof");
      sharedGone = true;
      shared = own(state.privateRoot.directory("retention-families"));
    }
    const f: Family = {
      state,
      root,
      slots,
      slot,
      sharedRoot,
      shared,
      meta,
      name: local.name,
      slotIdentity: local.inode,
      slotGeneration: local.slotGeneration,
      originHash: hash,
      sharedGone,
      close,
    };
    checkLocalIdentity(f);
    if (!sharedGone && !sameInode(identity(shared.stat), meta.sharedIdentity))
      throw Error("Shared family slot inode replaced");
    return f;
  } catch (error) {
    close();
    throw error;
  }
}
export function hasLocalRetentionFamily(
  state: InstallationState,
  origin: ControlExecutionOrigin,
): boolean {
  try {
    const f = openFamily(state, origin);
    f.close();
    return true;
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
}
function preallocateSharedRole(shared: AnchoredDirectory, role: ControlIssuer) {
  for (const [name, size] of [
    [`ack-${role}.json`, 4096],
    [`candidate-${role}.json`, 65536],
  ] as const)
    try {
      cell(shared, name, null, size, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  for (let n = 0; n < 32; n++)
    try {
      cell(shared, `shared-${role}-${n}.json`, [], 16384, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
}
/** Called by fixed admission/enlistment before any family record or assertion is exposed. */
export function reserveControlFamily(
  state: InstallationState,
  origin: ControlExecutionOrigin,
): void {
  try {
    const f = openFamily(state, origin);
    f.close();
    return;
  } catch (e) {
    if (!missing(e)) throw e;
  }
  if (state.fixedChildId) throw Error("A fixed child requires its role's already reserved family");
  const root = new AnchoredDirectory(state.dataRoot),
    control = root.directory(".admin-target-control", true, true),
    sharedRoot = control.directory("retention-families", true, true);
  const slots = state.privateRoot.directory("retention-families", true, true),
    locations = state.privateRoot.directory("retention-locations", true, true);
  const hash = originHash(origin);
  let shared: AnchoredDirectory | undefined, slot: AnchoredDirectory | undefined;
  try {
    if (json(state.privateRoot, "retention-slot-transaction.json", 4096) !== null)
      throw Error("Family slot release pending; reconcile before admission");
    let name: string | undefined;
    for (let n = 0; n < LIMITS.familiesPerRole; n++) {
      const candidate = `slot-${n}`;
      try {
        mkdirSync(slots.name(candidate), { mode: 0o700 });
        name = candidate;
        fsyncSync(slots.fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    if (!name) throw Error("Retained family capacity exhausted; await retention/containment");
    slot = slots.directory(name);
    try {
      shared = sharedRoot.directory(hash);
    } catch (e) {
      if (!missing(e) || origin.issuer !== state.installation.role) throw e;
      shared = sharedRoot.directory(hash, true, true);
      const meta: SharedIdentity = {
        version: 1,
        installationId: state.installation.installationId,
        origin,
        familyId: randomUUID(),
        generation: randomUUID(),
        dataRootIdentity: identity(root.stat),
        sharedIdentity: identity(shared.stat),
      };
      cell(
        shared,
        "identity.json",
        signed(state, "openmapx-retention-family-v1", meta),
        2048,
        true,
      );
      cell(
        shared,
        "decision.json",
        signed(state, "openmapx-retention-decision-v1", {
          version: 1,
          familyId: meta.familyId,
          generation: meta.generation,
          phase: "active",
          sequence: 0,
        }),
        8192,
        true,
      );
      cell(shared, "manifest.json", null, 32768, true);
      cell(shared, "api-ack.json", null, 4096, true);
      shared.directory("executions", true).close();
      shared.directory("intents", true).close();
      shared.directory("leases", true).close();
    }
    const rawIdentity = json(shared, "identity.json", 2048);
    const meta = verifyControl(
      state.publicKeys[origin.issuer],
      "openmapx-retention-family-v1",
      rawIdentity,
      sharedIdentitySchema,
    );
    if (
      controlDigest(meta.origin) !== hash ||
      !sameInode(meta.dataRootIdentity, identity(root.stat)) ||
      !sameInode(meta.sharedIdentity, identity(shared.stat))
    )
      throw Error("Origin physical identity mismatch");
    preallocateSharedRole(shared, state.installation.role);
    const slotGeneration = randomUUID();
    cell(
      slot,
      "identity.json",
      { familyId: meta.familyId, generation: meta.generation, slotGeneration, originHash: hash },
      2048,
      true,
    );
    for (let n = 0; n < LIMITS.indexPages; n++)
      cell(slot, `page-${n}.json`, [], LIMITS.indexPageBytes, true);
    for (const [file, size] of [
      ["manifest.json", 32768],
      ["commit.json", 8192],
      ["final.json", 8192],
      ["proof.json", 65536],
    ] as const)
      cell(slot, file, null, size, true);
    const p: Progress = {
      version: 1,
      familyId: meta.familyId,
      generation: meta.generation,
      sequence: 0,
      phase: "active",
      records: 0,
      sharedRecords: 0,
      metadataBytes: 1942528,
      executions: {},
      intents: {},
      leases: {},
      participants: [origin.issuer, state.installation.role].filter(
        (r, i, a) => a.indexOf(r) === i,
      ),
      terminalAt: 0,
      cursor: 0,
      sharedCursor: 0,
    };
    cell(slot, "progress.json", p, 131072, true);
    cell(slot, "progress-highwater.json", { sequence: 0, digest: controlDigest(p) }, 1024, true);
    locations.write(
      `${hash}.json`,
      canonicalJson({ name, inode: identity(slot.stat), slotGeneration, identity: rawIdentity }),
      true,
    );
  } finally {
    slot?.close();
    locations.close();
    slots.close();
    shared?.close();
    sharedRoot.close();
    control.close();
    root.close();
  }
}
function* records(f: Family): Generator<FamilyRecord> {
  const p = readProgress(f);
  let ordinal = 0;
  for (let n = 0; n < Math.ceil(p.records / LIMITS.pageEntries); n++) {
    const page = json<unknown[]>(f.slot, `page-${n}.json`, LIMITS.indexPageBytes);
    if (!Array.isArray(page) || page.length > 64) throw Error("Invalid retained index page");
    for (const value of page) {
      const e = entry(value);
      if (e.ordinal !== ordinal++) throw Error("Retention index ordinal mismatch");
      yield e;
    }
  }
  if (ordinal !== p.records) throw Error("Retention index count mismatch");
}
function recordSetDigest(values: Iterable<FamilyRecord>): string {
  const h = createHash("sha256");
  h.update("[");
  let first = true;
  for (const e of values) {
    if (!first) h.update(",");
    first = false;
    h.update(canonicalJson(tuple(e)));
  }
  h.update("]");
  return h.digest("hex");
}
function findRecord(
  f: Family,
  address: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
): FamilyRecord | undefined {
  for (const e of records(f)) if (equalAddress(e, address)) return e;
  return undefined;
}
function saveEntry(f: Family, e: FamilyRecord) {
  const n = Math.floor(e.ordinal / LIMITS.pageEntries),
    page = json<unknown[]>(f.slot, `page-${n}.json`, LIMITS.indexPageBytes);
  page[e.ordinal % LIMITS.pageEntries] = tuple(e);
  cell(f.slot, `page-${n}.json`, page, LIMITS.indexPageBytes);
}
function equalAddress(
  a: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
  b: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
) {
  return (
    a.scope === b.scope &&
    a.namespace === b.namespace &&
    a.name === b.name &&
    a.container === b.container
  );
}
export function familyRecordWrite(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  address: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
  bytes: string,
  write: (beforePublish: (inode: FileIdentity) => void) => void,
  exclusive = false,
): void {
  reserveControlFamily(state, origin);
  const f = openFamily(state, origin);
  try {
    let ref: FamilyRecord;
    guard(f.slot, ".family-writer", () => {
      checkLocalIdentity(f);
      const p = readProgress(f),
        old = findRecord(f, address);
      if (exclusive && old?.state === "written")
        throw Object.assign(Error("Exclusive retained record already exists"), { code: "EEXIST" });
      const nextDigest = controlDigest(bytes);
      if (old?.state === "written" && old.digest === nextDigest) {
        const d = recordDirectory(f, old);
        try {
          if (
            sameInode(d.dir.fileIdentity(old.name), old.inode) &&
            controlDigest(d.dir.read(old.name, LIMITS.privateRecordBytes).toString("utf8")) ===
              old.digest
          ) {
            ref = old;
            return;
          }
        } finally {
          d.close();
        }
      }
      if (p.phase !== "active" || decision(f).phase !== "active")
        throw Error("Retiring family is observation-only");
      if (
        !old &&
        (p.records >= LIMITS.recordsPerFamily ||
          (address.scope === "shared" && p.sharedRecords >= 2048))
      )
        throw Error("Family record capacity exhausted");
      ref = {
        ...address,
        digest: nextDigest,
        inode: old?.inode ?? { dev: "0", ino: "0" },
        ordinal: old?.ordinal ?? p.records,
        state: "written",
        counted: address.scope === "private",
        directory: false,
      };
      // The durable count reserves this ordinal before ordinary publication.
      // The inode-bound page is fsynced by the publication callback while the
      // same family writer is held. An interrupted rename leaves a pinned
      // mismatch, never an unindexed exposed record.
      if (!old) {
        p.records++;
        if (address.scope === "shared") p.sharedRecords++;
        progress(f, p, true);
      }
      write((inode) => {
        ref = { ...ref, inode };
        saveEntry(f, ref);
      });
    });
  } finally {
    f.close();
  }
}
export function trackFamilyDirectory(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  address: Pick<FamilyRecord, "namespace" | "name" | "container">,
  inode: FileIdentity,
  generation?: string,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        old = findRecord(f, { scope: "shared", ...address });
      if (old) {
        if (!sameInode(old.inode, inode)) throw Error("Replaced indexed directory");
        return;
      }
      if (
        p.phase !== "active" ||
        decision(f).phase !== "active" ||
        p.records >= LIMITS.recordsPerFamily ||
        p.sharedRecords >= 2048
      )
        throw Error("Retained directory capacity/fence");
      const e: FamilyRecord = {
        scope: "shared",
        ...address,
        inode,
        generation,
        digest: controlDigest({ inode, generation: generation ?? null }),
        ordinal: p.records,
        state: "written",
        counted: false,
        directory: true,
      };
      saveEntry(f, e);
      p.records++;
      p.sharedRecords++;
      progress(f, p, true);
    });
  } finally {
    f.close();
  }
}
function ticket(
  f: Family,
  p: Progress,
  kind: "executions" | "intents" | "leases",
  id: string,
  maximum: number,
  value: unknown,
) {
  const dir = f.shared.directory(kind);
  try {
    for (let n = 0; n < maximum; n++) {
      const name = `slot-${n}`;
      try {
        const existing = json<{ id: string; generation: string }>(dir, `${name}.json`, 4096);
        if (existing.id === id) {
          if (existing.generation !== f.meta.generation) throw Error("Ticket generation mismatch");
          return;
        }
      } catch (e) {
        if (!missing(e)) throw e;
      }
      const bytes = canonicalJson({ id, generation: f.meta.generation, value });
      if (p.metadataBytes + Buffer.byteLength(bytes) > LIMITS.familyMetadataBytes)
        throw Error("Origin retention metadata capacity exhausted before exposure");
      p.metadataBytes += Buffer.byteLength(bytes);
      progress(f, p, true);
      try {
        dir.write(`${name}.json`, bytes, true);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    throw Error(`Origin ${kind} capacity exhausted before effect`);
  } finally {
    dir.close();
  }
}
export function registerFamilyExecution(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  receiptDigest: string,
  parent?: RetainedParentExecution,
) {
  reserveControlFamily(state, origin);
  const f = openFamily(state, origin);
  try {
    guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        const p = readProgress(f),
          id = controlDigest(execution);
        if (p.executions[id]) {
          if (p.executions[id].receiptDigest !== receiptDigest)
            throw Error("Family execution conflict");
          return;
        }
        if (p.phase !== "active" || decision(f).phase !== "active")
          throw Error("Closed origin membership");
        ticket(f, p, "executions", id, LIMITS.executionsPerFamily, execution);
        p.executions[id] = {
          execution,
          receiptDigest,
          verifier: state.installation.publicKey,
          known: false,
          terminalAt: 0,
          terminalDigest: "0".repeat(64),
          requiresJournal: false,
          journalContained: false,
          ...(state.fixedChildId ? { fixedChildId: state.fixedChildId } : {}),
        };
        if (parent?.issuer === "api") {
          const api = {
            parent,
            operationKey: execution.operationKey,
            fingerprint: execution.fingerprint,
          };
          if (p.api && controlDigest(p.api) !== controlDigest(api))
            throw Error("Origin API parent conflict");
          p.api = api;
        }
        progress(f, p, true);
      }),
    );
  } finally {
    f.close();
  }
}
export function enlistFamilyIntent(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  id: string,
  child: ExecutionRef,
  recipient: ControlIssuer,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        const p = readProgress(f);
        if (p.phase !== "active" || decision(f).phase !== "active")
          throw Error("Closed origin intent membership");
        if (state.installation.role !== origin.issuer && !p.participants.includes(recipient))
          throw Error("Finite noncoordinator edge cannot enlist a third role");
        ticket(f, p, "intents", id, LIMITS.intentsPerFamily, {
          childDigest: controlDigest(child),
          recipient,
        });
        p.intents[id] = { id, childDigest: controlDigest(child), recipient };
        if (!p.participants.includes(recipient)) p.participants.push(recipient);
        preallocateSharedRole(f.shared, recipient);
        progress(f, p, true);
      }),
    );
  } finally {
    f.close();
  }
}
export function registerFamilyLease(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  id: string,
  certificateDigest: string,
  ownerRole: ControlIssuer,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        const p = readProgress(f);
        if (p.leases[id]) return;
        if (p.phase !== "active" || decision(f).phase !== "active")
          throw Error("Closed origin lease membership");
        ticket(f, p, "leases", id, LIMITS.executionsPerFamily, { certificateDigest, ownerRole });
        p.leases[id] = { id, certificateDigest, ownerRole, released: false };
        progress(f, p, true);
      }),
    );
  } finally {
    f.close();
  }
}
export function requireFamilyJournal(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
): void {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        fact = p.executions[controlDigest(execution)];
      if (!fact || p.phase !== "active") throw Error("Invalid journal dependency");
      fact.requiresJournal = true;
      fact.journalContained = false;
      progress(f, p);
    });
  } finally {
    f.close();
  }
}
export function completeFamilyJournal(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
): void {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        fact = p.executions[controlDigest(execution)];
      if (!fact?.requiresJournal || p.phase !== "active")
        throw Error("Invalid joined journal worker");
      fact.journalContained = true;
      p.terminalAt = Math.max(p.terminalAt, Date.now());
      progress(f, p);
    });
  } finally {
    f.close();
  }
}
export function markFamilyTerminal(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  known: boolean,
  terminalDigest?: string,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        e = p.executions[controlDigest(execution)];
      if (!e) throw Error("Missing indexed terminal execution");
      if (p.phase !== "active") {
        if (e.known && known && (!terminalDigest || e.terminalDigest === terminalDigest)) return;
        throw Error("Terminal transition after membership closed");
      }
      const changed =
        e.known !== known || (terminalDigest !== undefined && e.terminalDigest !== terminalDigest);
      e.known = known;
      if (terminalDigest) e.terminalDigest = terminalDigest;
      if (changed || e.terminalAt === undefined) {
        e.terminalAt = Date.now();
        p.terminalAt = Math.max(p.terminalAt, e.terminalAt);
      }
      progress(f, p);
    });
  } finally {
    f.close();
  }
}
export function markFamilyLeaseReleased(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  id: string,
  certificateDigest: string,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        lease = p.leases[id];
      if (
        !lease ||
        lease.certificateDigest !== certificateDigest ||
        lease.ownerRole !== state.installation.role
      )
        throw Error("Lease release family mismatch");
      if (lease.released) return;
      const value = {
        version: 1,
        familyId: f.meta.familyId,
        generation: f.meta.generation,
        originDigest: originHash(origin),
        leaseId: id,
        certificateDigest,
        releasedAt: Date.now(),
        role: state.installation.role,
      };
      lease.released = true;
      p.terminalAt = Math.max(p.terminalAt, value.releasedAt);
      progress(f, p);
    });
  } finally {
    f.close();
  }
}
function recordDirectory(f: Family, e: FamilyRecord): { dir: AnchoredDirectory; close(): void } {
  if (!safeName.test(e.name) || !(e.scope === "private" ? PRIVATE : SHARED).has(e.namespace))
    throw Error("Invalid fixed record address");
  const opened: AnchoredDirectory[] = [];
  let dir: AnchoredDirectory;
  if (e.scope === "private") dir = f.state.privateRoot.directory(e.namespace);
  else {
    let current = f.root.directory(".admin-target-control");
    opened.push(current);
    if (e.namespace === "execution") {
      if (!ROLES.includes(e.container as ControlIssuer)) throw Error("Invalid witness issuer");
      current = current.directory("executions");
      opened.push(current);
      dir = current.directory(e.container);
    } else if (e.namespace === "history-slot") {
      current = current.directory("admission-index-v1");
      opened.push(current);
      dir = current.directory("history");
    } else {
      if (!z.uuid().safeParse(e.container).success) throw Error("Invalid lease record container");
      current = current.directory("leases");
      opened.push(current);
      if (e.namespace === "lease-directory" && e.name === e.container) dir = current;
      else {
        current = current.directory(e.container);
        opened.push(current);
        dir =
          e.namespace === "lease-grants"
            ? current.directory("grants")
            : e.namespace === "lease-children"
              ? current.directory("children")
              : current;
        if (dir === current) opened.pop();
      }
    }
  }
  return {
    dir,
    close() {
      dir.close();
      for (const d of opened.reverse()) d.close();
    },
  };
}
function readAllTickets(
  f: Family,
  kind: "executions" | "intents" | "leases",
  maximum: number,
): Array<{ id: string; value: unknown }> {
  const d = f.shared.directory(kind),
    result: Array<{ id: string; value: unknown }> = [];
  try {
    for (let n = 0; n < maximum; n++)
      try {
        const t = json<{ id: string; generation: string; value: unknown }>(
          d,
          `slot-${n}.json`,
          4096,
        );
        if (t.generation !== f.meta.generation) throw Error("Stale family ticket generation");
        result.push(t);
      } catch (e) {
        if (!missing(e)) throw e;
      }
    return result;
  } finally {
    d.close();
  }
}
function directoryPresent(parent: AnchoredDirectory, name: string): boolean {
  try {
    const dir = parent.directory(name);
    dir.close();
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function executionWriterPresent(f: Family, execution: ExecutionRef): boolean {
  const opened: AnchoredDirectory[] = [];
  const own = (d: AnchoredDirectory) => {
    opened.push(d);
    return d;
  };
  try {
    try {
      const effects = own(f.state.privateRoot.directory("effect-writers"));
      if (directoryPresent(effects, execution.operationKey)) return true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const control = own(f.root.directory(".admin-target-control")),
      executions = own(control.directory("executions")),
      role = own(executions.directory(execution.executor));
    return directoryPresent(role, `${execution.operationKey}.writer`);
  } finally {
    for (const dir of opened.reverse()) dir.close();
  }
}
function localProof(f: Family, p: Progress): boolean {
  if (
    !Object.keys(p.executions).length ||
    Object.values(p.executions).some((e) => !e.known || e.terminalAt === undefined)
  )
    return false;
  for (const fact of Object.values(p.executions)) {
    if (executionWriterPresent(f, fact.execution)) return false;
    if (
      fact.requiresJournal &&
      (!fact.journalContained ||
        !f.state.retentionJournal?.contained(fact.execution, fact.terminalDigest))
    )
      return false;
    const executions = f.state.privateRoot.directory("executions"),
      effects = f.state.privateRoot.directory("effects"),
      lifecycle = f.state.privateRoot.directory("execution-lifecycle");
    try {
      const raw = json<unknown>(executions, `${fact.execution.operationKey}.json`, 65536);
      if (controlDigest(raw) !== fact.receiptDigest) return false;
      const admitted = verifyControl(
        fact.verifier,
        "openmapx-control-execution-v2",
        raw,
        z
          .object({ version: z.literal(2), execution: z.unknown(), origin: originSchema })
          .passthrough(),
      );
      if (
        controlDigest(admitted.execution) !== controlDigest(fact.execution) ||
        controlDigest(admitted.origin) !== f.originHash
      )
        return false;
      const terminal = verifyControl(
        fact.verifier,
        "openmapx-control-settlement-v1",
        json(effects, `${fact.execution.operationKey}.json`, 65536),
        z
          .object({
            identity: z.unknown(),
            outcome: z.enum(["contained", "committed", "failed_without_effect"]),
            publication: z.enum(["not_started", "committed"]),
            terminalReceiptDigest: z.string(),
            receipt: z.unknown(),
          })
          .passthrough(),
      );
      if (
        controlDigest(terminal.identity) !== controlDigest(fact.execution) ||
        terminal.terminalReceiptDigest !== controlDigest(terminal.receipt)
      )
        return false;
      const phase = verifyControl(
        fact.verifier,
        "openmapx-execution-lifecycle-v1",
        json(lifecycle, `${fact.execution.operationKey}.json`, 65536),
        z.object({ execution: z.unknown(), phase: z.literal("settled") }).passthrough(),
      );
      if (controlDigest(phase.execution) !== controlDigest(fact.execution)) return false;
    } finally {
      lifecycle.close();
      effects.close();
      executions.close();
    }
  }
  for (const lease of Object.values(p.leases)) {
    const control = f.root.directory(".admin-target-control"),
      leases = control.directory("leases"),
      ledger = leases.directory(lease.id);
    try {
      if (directoryPresent(ledger, ".journal-writer")) return false;
      const released = verified<{
        leaseId: string;
        certificateDigest: string;
        releasedAt?: number;
      }>(
        f.state,
        lease.ownerRole,
        "openmapx-admission-slots-v1",
        json(ledger, "admission.json", 4096),
      );
      if (
        released.leaseId !== lease.id ||
        released.certificateDigest !== lease.certificateDigest ||
        !released.releasedAt
      )
        return false;
    } finally {
      ledger.close();
      leases.close();
      control.close();
    }
  }
  return true;
}
function sameFamily(f: Family, v: { familyId: string; generation: string; originDigest?: string }) {
  if (
    v.familyId !== f.meta.familyId ||
    v.generation !== f.meta.generation ||
    (v.originDigest !== undefined && v.originDigest !== f.originHash)
  )
    throw Error("Retirement family/generation mismatch");
}
function ack(f: Family, role: ControlIssuer): Ack | null {
  const raw = json<unknown>(f.shared, `ack-${role}.json`, 4096);
  if (raw === null) return null;
  const a = verified<Ack>(f.state, role, "openmapx-retention-ack-v1", raw);
  sameFamily(f, a);
  if (
    a.role !== role ||
    !DIGEST.test(a.manifestDigest) ||
    !["ready", "clean", "released"].includes(a.phase) ||
    !Number.isSafeInteger(a.sequence) ||
    a.sequence < 1
  )
    throw Error("Invalid retirement acknowledgement");
  return a;
}
function manifest(f: Family): Manifest {
  const m = verified<Manifest>(
    f.state,
    f.meta.origin.issuer,
    "openmapx-retention-manifest-v1",
    json(f.shared, "manifest.json", 32768),
  );
  sameFamily(f, m);
  if (
    m.version !== 1 ||
    m.installationId !== f.state.installation.installationId ||
    controlDigest(m.origin) !== f.originHash ||
    Object.keys(m.executionReceiptDigests).length > LIMITS.executionsPerFamily ||
    m.participants.length > 4
  )
    throw Error("Invalid retirement manifest");
  return m;
}
function publishAck(f: Family, p: Progress, m: Manifest, phase: Ack["phase"]) {
  const old = ack(f, f.state.installation.role);
  if (old && old.manifestDigest !== controlDigest(m))
    throw Error("Conflicting retirement acknowledgement");
  if (old && old.sequence >= Number.MAX_SAFE_INTEGER)
    throw Error("Retirement acknowledgement sequence exhausted");
  const value: Ack = {
    version: 1,
    installationId: f.state.installation.installationId,
    familyId: f.meta.familyId,
    generation: f.meta.generation,
    originDigest: f.originHash,
    manifestDigest: controlDigest(m),
    role: f.state.installation.role,
    phase,
    terminalSequenceDigest: m.terminalSequenceDigest,
    recordSetDigest: m.localRecordSetDigests[f.state.installation.role] ?? "",
    proofCopyDigest: controlDigest({
      proof: json(f.slot, "proof.json", 65536),
      manifest: json(f.slot, "manifest.json", 32768),
      commit: json(f.slot, "commit.json", 8192),
      final: json(f.slot, "final.json", 8192),
    }),
    sequence: (old?.sequence ?? 0) + 1,
  };
  cell(
    f.shared,
    `ack-${f.state.installation.role}.json`,
    signed(f.state, "openmapx-retention-ack-v1", value),
    4096,
  );
  p.phase = phase;
  progress(f, p);
}
function publishCandidate(f: Family, p: Progress): Candidate | null {
  if (
    Date.now() < f.meta.origin.notAfter ||
    Date.now() - p.terminalAt < LIMITS.minimumTerminalRetentionMs ||
    !localProof(f, p)
  )
    return null;
  let sharedPage: unknown[] = [],
    sharedPageNumber = 0,
    sharedCount = 0;
  const flush = () => {
    cell(
      f.shared,
      `shared-${f.state.installation.role}-${sharedPageNumber++}.json`,
      sharedPage,
      16384,
    );
    sharedPage = [];
  };
  for (const e of records(f)) {
    if (e.state !== "written") return null;
    const d = recordDirectory(f, e);
    try {
      if (e.directory) {
        const child = d.dir.directory(e.name);
        try {
          if (!sameInode(identity(child.stat), e.inode))
            throw Error("Retirement directory replaced");
        } finally {
          child.close();
        }
      } else if (
        !sameInode(d.dir.fileIdentity(e.name), e.inode) ||
        controlDigest(d.dir.read(e.name, LIMITS.privateRecordBytes).toString("utf8")) !== e.digest
      )
        throw Error("Retirement record replaced");
    } finally {
      d.close();
    }
    if (e.scope === "shared") {
      if (++sharedCount > 2048) throw Error("Shared retirement record workspace exhausted");
      sharedPage.push(tuple(e));
      if (sharedPage.length === 64) flush();
    }
  }
  if (sharedPage.length) flush();
  while (sharedPageNumber < 32) flush();
  const executionReceiptDigests = Object.fromEntries(
    Object.entries(p.executions).map(([id, e]) => [id, e.terminalDigest ?? e.receiptDigest]),
  );
  const candidate: Candidate = {
    version: 1,
    installationId: f.state.installation.installationId,
    familyId: f.meta.familyId,
    generation: f.meta.generation,
    role: f.state.installation.role,
    originDigest: f.originHash,
    terminalAt: p.terminalAt,
    terminalSequenceDigest: controlDigest(
      Object.values(p.executions).map((e) => ({
        execution: e.execution,
        terminalAt: e.terminalAt,
        digest: e.terminalDigest ?? e.receiptDigest,
      })),
    ),
    executionReceiptDigests,
    leaseDigests: Object.fromEntries(
      Object.values(p.leases).map((l) => [l.id, l.certificateDigest]),
    ),
    intentDigests: Object.fromEntries(Object.values(p.intents).map((i) => [i.id, i.childDigest])),
    localRecordSetDigest: recordSetDigest(records(f)),
    sharedRecordSetDigest: recordSetDigest(readSharedRecords(f, f.state.installation.role)),
  };
  cell(
    f.shared,
    `candidate-${f.state.installation.role}.json`,
    signed(f.state, "openmapx-retention-candidate-v1", candidate),
    65536,
  );
  return candidate;
}
function* readSharedRecords(f: Family, role: ControlIssuer): Generator<FamilyRecord> {
  for (let page = 0; page < 32; page++) {
    const values = json<unknown[]>(f.shared, `shared-${role}-${page}.json`, 16384);
    if (!Array.isArray(values) || values.length > 64) throw Error("Corrupt shared ownership page");
    for (const value of values) yield entry(value);
  }
}
function prepare(f: Family, p: Progress): boolean {
  if (f.state.installation.role !== f.meta.origin.issuer || f.state.fixedChildId) return false;
  return guard(f.shared, ".membership-writer", () => {
    if (decision(f).phase !== "active") return true;
    const candidates: Candidate[] = [];
    for (const role of p.participants) {
      const raw = json<unknown>(f.shared, `candidate-${role}.json`, 65536);
      if (raw === null) return false;
      const c = verified<Candidate>(f.state, role, "openmapx-retention-candidate-v1", raw);
      sameFamily(f, c);
      if (
        c.role !== role ||
        c.installationId !== f.state.installation.installationId ||
        Date.now() - c.terminalAt < LIMITS.minimumTerminalRetentionMs
      )
        return false;
      if (recordSetDigest(readSharedRecords(f, role)) !== c.sharedRecordSetDigest)
        throw Error("Shared ownership digest conflict");
      candidates.push(c);
    }
    const receipts = Object.assign(
      {},
      ...candidates.map((c) => c.executionReceiptDigests),
    ) as Record<string, string>;
    const executions = readAllTickets(f, "executions", LIMITS.executionsPerFamily);
    const intents = readAllTickets(f, "intents", LIMITS.intentsPerFamily);
    if (
      Object.keys(receipts).length !== executions.length ||
      executions.some((t) => !receipts[t.id]) ||
      intents.some((t) => !receipts[(t.value as { childDigest: string }).childDigest])
    )
      return false;
    const intentDigests = Object.assign({}, ...candidates.map((c) => c.intentDigests)) as Record<
      string,
      string
    >;
    if (
      Object.keys(intentDigests).length !== intents.length ||
      Object.values(intentDigests).some((id) => !receipts[id]) ||
      intents.some((t) => intentDigests[t.id] !== (t.value as { childDigest: string }).childDigest)
    )
      return false;
    const leaseDigests = Object.assign({}, ...candidates.map((c) => c.leaseDigests)) as Record<
        string,
        string
      >,
      leases = readAllTickets(f, "leases", LIMITS.executionsPerFamily);
    if (
      Object.keys(leaseDigests).length !== leases.length ||
      leases.some(
        (t) => leaseDigests[t.id] !== (t.value as { certificateDigest: string }).certificateDigest,
      )
    )
      return false;
    const external: string[] = [];
    if (p.api) {
      const a = apiCopy(f, p);
      const root = Object.values(p.executions).find(
        (e) => e.execution.operationKey === p.api?.operationKey,
      );
      if (
        !a ||
        !root?.terminalDigest ||
        a.operationKey !== p.api.operationKey ||
        a.fingerprint !== p.api.fingerprint ||
        a.terminalDigest !== root.terminalDigest
      )
        return false;
      external.push(`api:${p.api.parent.apiJobId}:${p.api.parent.attemptId}`);
    }
    const m: Manifest = {
      version: 1,
      installationId: f.state.installation.installationId,
      origin: f.meta.origin,
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      sequence: 1,
      terminalAt: Math.max(...candidates.map((c) => c.terminalAt)),
      terminalSequenceDigest: controlDigest({
        roles: candidates.map((c) => c.terminalSequenceDigest),
        api: p.api ? apiCopy(f, p) : null,
      }),
      participants: [...p.participants, ...external],
      executionReceiptDigests: receipts,
      sharedRecordSetDigest: controlDigest(candidates.map((c) => c.sharedRecordSetDigest)),
      localRecordSetDigests: Object.fromEntries(
        candidates.map((c) => [c.role, c.localRecordSetDigest]),
      ),
    };
    advanceRetentionClock(f.state, f.meta.origin.notAfter);
    const envelope = signed(f.state, "openmapx-retention-manifest-v1", m);
    cell(f.slot, "manifest.json", envelope, 32768);
    cell(f.shared, "manifest.json", envelope, 32768);
    writeDecision(f, {
      version: 1,
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      phase: "prepared",
      manifestDigest: controlDigest(m),
      sequence: 1,
    });
    p.phase = "prepared";
    p.manifestDigest = controlDigest(m);
    progress(f, p);
    return true;
  });
}
function roleIds(m: Manifest): ControlIssuer[] {
  return m.participants.filter((p): p is ControlIssuer => ROLES.includes(p as ControlIssuer));
}
function validateAck(_f: Family, m: Manifest, a: Ack | null, phase: Ack["phase"]): a is Ack {
  return (
    !!a &&
    a.phase === phase &&
    a.manifestDigest === controlDigest(m) &&
    a.terminalSequenceDigest === m.terminalSequenceDigest &&
    a.recordSetDigest === m.localRecordSetDigests[a.role]
  );
}
function unlinkShared(f: Family, p: Progress, e: FamilyRecord) {
  const previous = p.sharedTransaction;
  if (
    previous &&
    (previous.ordinal !== e.ordinal || controlDigest(previous.record) !== controlDigest(e))
  )
    throw Error("Shared retirement transaction conflict");
  const d = recordDirectory(f, e);
  try {
    if (!previous) {
      // Absence is resumable only after this exact item has a durable plan.
      if (e.directory) {
        const child = d.dir.directory(e.name);
        try {
          if (!sameInode(identity(child.stat), e.inode))
            throw Error("Replaced retirement directory");
          if (
            e.generation &&
            json<{ generation: string }>(child, "generation.json", 1024).generation !== e.generation
          )
            throw Error("Reused history slot generation");
        } finally {
          child.close();
        }
      } else if (
        !sameInode(d.dir.fileIdentity(e.name), e.inode) ||
        controlDigest(d.dir.read(e.name, LIMITS.privateRecordBytes).toString("utf8")) !== e.digest
      )
        throw Error("Replaced shared retirement record");
      p.sharedTransaction = { ordinal: e.ordinal, phase: "planned", record: e };
      progress(f, p);
    }
    if (p.sharedTransaction?.phase === "planned") {
      try {
        if (e.directory) {
          const child = d.dir.directory(e.name);
          try {
            if (!sameInode(identity(child.stat), e.inode))
              throw Error("Replaced retirement directory");
          } finally {
            child.close();
          }
          if (e.generation) {
            const child = d.dir.directory(e.name);
            try {
              try {
                const g = json<{ generation: string }>(child, "generation.json", 1024);
                if (g.generation !== e.generation) throw Error("Reused history slot generation");
                child.removeFile("generation.json");
              } catch (error) {
                if (!missing(error)) throw error;
              }
            } finally {
              child.close();
            }
          }
          d.dir.removeDirectory(e.name, e.inode);
        } else {
          if (
            !sameInode(d.dir.fileIdentity(e.name), e.inode) ||
            controlDigest(d.dir.read(e.name, LIMITS.privateRecordBytes).toString("utf8")) !==
              e.digest
          )
            throw Error("Replaced shared retirement record");
          d.dir.removeFile(e.name);
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
      p.sharedTransaction = { ordinal: e.ordinal, phase: "unlinked", record: e };
      progress(f, p);
    }
    p.sharedCursor++;
    delete p.sharedTransaction;
    progress(f, p);
  } finally {
    d.close();
  }
}
function cleanupLocalRecords(f: Family, p: Progress, m: Manifest): boolean {
  if (p.lastDone) {
    const dir = f.state.privateRoot.directory(p.lastDone.namespace);
    try {
      finishRetainedDeletion(dir, {
        ...p.lastDone,
        familyId: f.meta.familyId,
        generation: f.meta.generation,
        manifestDigest: controlDigest(m),
      });
    } finally {
      dir.close();
    }
    delete p.lastDone;
    progress(f, p);
  }
  let remaining = 64;
  while (p.cursor < p.records && remaining--) {
    const page = json<unknown[]>(f.slot, `page-${Math.floor(p.cursor / 64)}.json`, 16384);
    const e = entry(page[p.cursor % 64]);
    if (e.ordinal !== p.cursor) throw Error("Missing local cleanup ordinal");
    if (e.scope !== "private") {
      p.cursor++;
      progress(f, p);
      continue;
    }
    const d = recordDirectory(f, e);
    try {
      deleteRetainedRecord(
        d.dir,
        {
          familyId: f.meta.familyId,
          generation: f.meta.generation,
          manifestDigest: controlDigest(m),
          ordinal: e.ordinal,
          name: e.name,
          inode: e.inode,
          digest: e.digest,
        },
        () => {
          p.cursor++;
          p.lastDone = {
            namespace: e.namespace,
            ordinal: e.ordinal,
            name: e.name,
            inode: e.inode,
            digest: e.digest,
          };
          progress(f, p);
        },
      );
      delete p.lastDone;
      progress(f, p);
    } finally {
      d.close();
    }
  }
  return p.cursor === p.records;
}
function cleanupSharedRecords(f: Family, p: Progress, m: Manifest): boolean {
  // Four fixed passes preserve physical containment: files, ledger subdirs,
  // ledger roots, then history slots. Resume uses the same fixed ordinal space
  // and reads one <=16KiB ownership page at a time.
  const roles = roleIds(m),
    perPass = roles.length * 2048,
    total = perPass * 4;
  let budget = 64,
    dirty = false;
  const passFor = (e: FamilyRecord) =>
    !e.directory ? 0 : e.namespace === "history-slot" ? 3 : e.name === e.container ? 2 : 1;
  let cached = "",
    page: unknown[] = [];
  while (p.sharedCursor < total && budget > 0) {
    const cursor = p.sharedCursor,
      pass = Math.floor(cursor / perPass),
      within = cursor % perPass,
      role = roles[Math.floor(within / 2048)],
      offset = within % 2048,
      pageNumber = Math.floor(offset / 64),
      key = `${role}:${pageNumber}`;
    if (!role) throw Error("Invalid shared cleanup role cursor");
    if (cached !== key) {
      page = json<unknown[]>(f.shared, `shared-${role}-${pageNumber}.json`, 16384);
      if (!Array.isArray(page) || page.length > 64) throw Error("Corrupt shared cleanup page");
      cached = key;
    }
    const value = page[offset % 64];
    if (value === undefined) {
      p.sharedCursor += 64 - (offset % 64);
      dirty = true;
      continue;
    }
    const e = entry(value);
    if (passFor(e) !== pass) {
      p.sharedCursor++;
      dirty = true;
      continue;
    }
    if (dirty) {
      progress(f, p);
      dirty = false;
    }
    unlinkShared(f, p, { ...e, ordinal: cursor });
    budget--;
  }
  if (dirty) progress(f, p);
  return p.sharedCursor === total;
}
const SLOT_FILES = [
  ...Array.from({ length: 64 }, (_, n) => `page-${n}.json`),
  "manifest.json",
  "commit.json",
  "final.json",
  "proof.json",
  "progress.json",
  "progress-highwater.json",
  "identity.json",
];
interface SlotRelease {
  familyId: string;
  generation: string;
  slotGeneration: string;
  name: string;
  inode: FileIdentity;
  originHash: string;
  role: ControlIssuer;
  proof: unknown;
  phase: "planned" | "item_done";
}
function resumeSlotRelease(state: InstallationState): boolean {
  return guard(state.privateRoot, ".retention-slot-writer", () => {
    const t = json<SlotRelease | null>(state.privateRoot, "retention-slot-transaction.json", 4096);
    if (t === null) return false;
    if (
      !slotName.test(t.name) ||
      !DIGEST.test(t.originHash) ||
      !ROLES.includes(t.role) ||
      !z.uuid().safeParse(t.slotGeneration).success
    )
      throw Error("Corrupt family slot transaction");
    const proof = verified<Decision & { semanticClean?: boolean }>(
      state,
      t.role,
      "openmapx-retention-decision-v1",
      t.proof,
    );
    if (
      proof.familyId !== t.familyId ||
      proof.generation !== t.generation ||
      proof.phase !== "final" ||
      !proof.semanticClean
    )
      throw Error("Invalid final slot-release proof");
    const slots = state.privateRoot.directory("retention-families");
    try {
      let slot: AnchoredDirectory | undefined;
      try {
        slot = slots.directory(t.name);
      } catch (e) {
        if (!missing(e)) throw e;
      }
      if (slot) {
        try {
          if (!sameInode(identity(slot.stat), t.inode))
            throw Error("Slot transaction inode replaced");
          try {
            const id = json<{ familyId: string; generation: string; slotGeneration: string }>(
              slot,
              "identity.json",
              2048,
            );
            if (
              id.familyId !== t.familyId ||
              id.generation !== t.generation ||
              id.slotGeneration !== t.slotGeneration
            )
              throw Error("Slot transaction generation replaced");
          } catch (e) {
            if (!missing(e)) throw e;
          }
          for (const name of SLOT_FILES)
            try {
              slot.removeFile(name);
            } catch (e) {
              if (!missing(e)) throw e;
            }
        } finally {
          slot.close();
        }
        slots.removeDirectory(t.name, t.inode);
      }
      const loc = state.privateRoot.directory("retention-locations");
      try {
        try {
          loc.removeFile(`${t.originHash}.json`);
        } catch (e) {
          if (!missing(e)) throw e;
        }
      } finally {
        loc.close();
      }
      cell(
        state.privateRoot,
        "retention-slot-transaction.json",
        { ...t, phase: "item_done" },
        4096,
      );
      cell(state.privateRoot, "retention-slot-transaction.json", null, 4096);
      return true;
    } finally {
      slots.close();
    }
  });
}
function freeFamily(f: Family, _p: Progress): void {
  guard(f.state.privateRoot, ".retention-slot-writer", () => {
    if (json(f.state.privateRoot, "retention-slot-transaction.json", 4096) !== null)
      throw Error("Other slot transaction pending");
    checkLocalIdentity(f);
    const t: SlotRelease = {
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      slotGeneration: f.slotGeneration,
      name: f.name,
      inode: f.slotIdentity,
      originHash: f.originHash,
      role: f.meta.origin.issuer,
      proof: json(f.slot, "final.json", 8192),
      phase: "planned",
    };
    cell(f.state.privateRoot, "retention-slot-transaction.json", t, 4096);
  });
  resumeSlotRelease(f.state);
}
function freeSharedWorkspace(f: Family, p: Progress, m: Manifest): void {
  if (f.sharedGone) return;
  p.sharedRelease = true;
  progress(f, p);
  const names = [
    "identity.json",
    "decision.json",
    "manifest.json",
    "api-ack.json",
    ...roleIds(m).flatMap((role) => [
      `ack-${role}.json`,
      `candidate-${role}.json`,
      ...Array.from({ length: 32 }, (_, n) => `shared-${role}-${n}.json`),
    ]),
  ];
  for (const kind of ["executions", "intents", "leases"] as const) {
    let dir: AnchoredDirectory;
    try {
      dir = f.shared.directory(kind);
    } catch (e) {
      if (missing(e)) continue;
      throw e;
    }
    try {
      const max = kind === "intents" ? 256 : 128;
      for (let n = 0; n < max; n++)
        try {
          dir.removeFile(`slot-${n}.json`);
        } catch (e) {
          if (!missing(e)) throw e;
        }
      const inode = identity(dir.stat);
      dir.close();
      f.shared.removeDirectory(kind, inode);
    } finally {
      dir.close();
    }
  }
  for (const name of names)
    try {
      f.shared.removeFile(name);
    } catch (e) {
      if (!missing(e)) throw e;
    }
  try {
    f.sharedRoot.removeDirectory(f.originHash, identity(f.shared.stat));
  } catch (e) {
    if (!missing(e)) throw e;
  }
}
function assertPrivateRetirementProof(f: Family, m: Manifest): void {
  const local = verifyControl(
    f.state.publicKeys[f.meta.origin.issuer],
    "openmapx-retention-manifest-v1",
    json(f.slot, "manifest.json", 32768),
    z.unknown(),
  );
  if (controlDigest(local) !== controlDigest(m))
    throw Error("Private retirement manifest copy changed");
  const proof = verified<Candidate>(
    f.state,
    f.state.installation.role,
    "openmapx-retention-candidate-v1",
    json(f.slot, "proof.json", 65536),
  );
  sameFamily(f, proof);
  if (
    proof.role !== f.state.installation.role ||
    proof.localRecordSetDigest !== m.localRecordSetDigests[proof.role] ||
    Object.entries(proof.executionReceiptDigests).some(
      ([id, digest]) => m.executionReceiptDigests[id] !== digest,
    )
  )
    throw Error("Private terminal proof copy changed");
}
async function step(f: Family): Promise<boolean> {
  if (f.state.fixedChildId) throw Error("Fixed children do not coordinate role-private retirement");
  let p = readProgress(f);
  checkLocalIdentity(f);
  if (p.phase === "released" && f.state.installation.role !== f.meta.origin.issuer) {
    freeFamily(f, p);
    return true;
  }
  if (p.phase === "released" && p.sharedRelease) {
    const m = verified<Manifest>(
      f.state,
      f.meta.origin.issuer,
      "openmapx-retention-manifest-v1",
      json(f.slot, "manifest.json", 32768),
    );
    freeSharedWorkspace(f, p, m);
    freeFamily(f, p);
    return true;
  }
  const d = decision(f);
  if (d.phase === "active") {
    guard(f.slot, ".family-writer", () => publishCandidate(f, p));
    if (!prepare(f, p)) return false;
    p = readProgress(f);
  }
  const m = manifest(f),
    md = controlDigest(m);
  if (decision(f).manifestDigest !== md) throw Error("Manifest/decision digest conflict");
  if (p.phase === "active" || p.phase === "prepared") {
    for (const e of records(f)) if (e.state !== "written") return false;
    if (
      recordSetDigest(records(f)) !== m.localRecordSetDigests[f.state.installation.role] ||
      !localProof(f, p)
    )
      return false;
    cell(f.slot, "manifest.json", json(f.shared, "manifest.json", 32768), 32768);
    cell(
      f.slot,
      "proof.json",
      json(f.shared, `candidate-${f.state.installation.role}.json`, 65536),
      65536,
    );
    p.manifestDigest = md;
    publishAck(f, p, m, "ready");
  }
  assertPrivateRetirementProof(f, m);
  if (f.state.installation.role === f.meta.origin.issuer && decision(f).phase === "prepared") {
    const readyDigests: Record<string, string> = {};
    for (const role of roleIds(m)) {
      const a = ack(f, role);
      if (!validateAck(f, m, a, "ready")) return false;
      readyDigests[role] = controlDigest(a);
    }
    writeDecision(f, {
      version: 1,
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      phase: "committed",
      manifestDigest: md,
      readyDigests,
      sequence: 2,
    });
  }
  if (decision(f).phase === "prepared") return false;
  if (p.phase === "ready" || p.phase === "committed") {
    const commit = decision(f);
    if (commit.phase !== "committed" && commit.phase !== "final") return false;
    cell(f.slot, "commit.json", json(f.shared, "decision.json", 8192), 8192);
    advanceRetentionClock(f.state, f.meta.origin.notAfter);
    p.phase = "committed";
    progress(f, p);
    if (!cleanupLocalRecords(f, p, m)) return false;
    if (Object.values(p.executions).some((e) => e.requiresJournal) && !p.journalClean) {
      if (!f.state.retentionJournal) return false;
      p.journalCleanupPlanned = true;
      progress(f, p);
      await f.state.retentionJournal.retire(
        Object.values(p.executions)
          .filter((e) => e.requiresJournal)
          .map((e) => {
            if (!e.terminalDigest) throw Error("Missing retiring terminal digest");
            return { execution: e.execution, digest: e.terminalDigest };
          }),
        md,
      );
      p = readProgress(f);
      p.journalClean = true;
      progress(f, p);
    }
    publishAck(f, p, m, "clean");
  }
  if (f.state.installation.role === f.meta.origin.issuer && decision(f).phase === "committed") {
    const cleanDigests: Record<string, string> = {};
    for (const role of roleIds(m)) {
      const a = ack(f, role);
      if (!validateAck(f, m, a, "clean")) return false;
      cleanDigests[role] = controlDigest(a);
    }
    writeDecision(f, {
      version: 1,
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      phase: "final",
      manifestDigest: md,
      cleanDigests,
      sequence: 3,
    });
  }
  if (decision(f).phase !== "final") return false;
  if (f.state.installation.role === f.meta.origin.issuer && !cleanupSharedRecords(f, p, m))
    return false;
  // Participants can release only after coordinator's final semantic cleanup.
  if (f.state.installation.role === f.meta.origin.issuer) {
    cell(
      f.shared,
      "decision.json",
      signed(f.state, "openmapx-retention-decision-v1", { ...decision(f), semanticClean: true }),
      8192,
    );
  }
  const final = decision(f) as Decision & { semanticClean?: boolean };
  if (!final.semanticClean) return false;
  cell(f.slot, "final.json", json(f.shared, "decision.json", 8192), 8192);
  if (p.phase !== "released") publishAck(f, p, m, "released");
  if (f.state.installation.role !== f.meta.origin.issuer) {
    freeFamily(f, p);
    return true;
  }
  for (const role of roleIds(m)) if (!validateAck(f, m, ack(f, role), "released")) return false;
  freeSharedWorkspace(f, p, m);
  freeFamily(f, p);
  return true;
}
export async function reconcileRetentionFamilies(
  state: InstallationState,
  options: { signal?: AbortSignal; maxFamilies?: number } = {},
): Promise<{ retired: number; pending: number }> {
  const max = options.maxFamilies ?? 16;
  if (!Number.isSafeInteger(max) || max < 1 || max > 64)
    throw Error("Invalid retention maxFamilies");
  options.signal?.throwIfAborted();
  try {
    mkdirSync(state.privateRoot.name(".retention-reconcile-writer"), { mode: 0o700 });
    fsyncSync(state.privateRoot.fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { retired: 0, pending: 1 };
    throw error;
  }
  const held = state.privateRoot.directory(".retention-reconcile-writer"),
    expected = identity(held.stat);
  try {
    return await reconcileRetentionFamiliesLocked(state, options);
  } finally {
    held.close();
    state.privateRoot.removeDirectory(".retention-reconcile-writer", expected);
  }
}
async function reconcileRetentionFamiliesLocked(
  state: InstallationState,
  options: { signal?: AbortSignal; maxFamilies?: number } = {},
): Promise<{ retired: number; pending: number }> {
  const max = options.maxFamilies ?? 16;
  if (!Number.isSafeInteger(max) || max < 1 || max > 64)
    throw Error("Invalid retention maxFamilies");
  const clock = readRetentionClock(state);
  if (Date.now() < clock.lastRetirementWallTime)
    throw Error("Wall clock moved backward; retention recovery prerequisite");
  const recovered = resumeSlotRelease(state);
  const cursorName = "retention-cursor.json";
  let cursor = json<number>(state.privateRoot, cursorName, 64);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= 1024)
    throw Error("Invalid retention cursor");
  let retired = recovered ? 1 : 0,
    pending = 0,
    seen = 0;
  let slots: AnchoredDirectory;
  try {
    slots = state.privateRoot.directory("retention-families");
  } catch (e) {
    if (missing(e)) return { retired, pending };
    throw e;
  }
  try {
    for (let scanned = 0; scanned < 1024 && seen < max; scanned++) {
      options.signal?.throwIfAborted();
      const name = `slot-${cursor}`;
      cursor = (cursor + 1) % 1024;
      let slot: AnchoredDirectory;
      try {
        slot = slots.directory(name);
      } catch (e) {
        if (missing(e)) continue;
        throw e;
      }
      let hash: string | undefined;
      try {
        const local = json<{ originHash?: string }>(slot, "identity.json", 2048);
        hash = local.originHash;
      } catch {
        seen++;
        pending++;
      } finally {
        slot.close();
      }
      if (!hash) {
        if (hash === undefined && seen === 0) {
          /* old partial index stays reserved */
        }
        continue;
      }
      seen++;
      try {
        const locations = state.privateRoot.directory("retention-locations");
        let meta: SharedIdentity;
        try {
          const loc = json<{ identity: unknown }>(locations, `${hash}.json`, 4096);
          const candidate = (loc.identity as { payload: SharedIdentity }).payload;
          meta = verifyControl(
            state.publicKeys[candidate.origin.issuer],
            "openmapx-retention-family-v1",
            loc.identity,
            sharedIdentitySchema,
          );
        } finally {
          locations.close();
        }
        const f = openFamily(state, meta.origin);
        try {
          if (await step(f)) retired++;
          else pending++;
        } catch (error) {
          try {
            guard(f.slot, ".family-writer", () => {
              const p = readProgress(f);
              p.lastError = String(error).slice(0, 512);
              progress(f, p);
            });
          } catch {}
          throw error;
        } finally {
          f.close();
        }
      } catch {
        pending++;
      }
    }
  } finally {
    cell(state.privateRoot, cursorName, cursor, 64);
    slots.close();
  }
  return { retired, pending };
}
/** Exact retained API dependency lookup; absence proof is bounded by the active family slots. */
export function retentionApiDependency(
  state: InstallationState,
  origin: ControlExecutionOrigin,
): ApiDependency | undefined {
  const f = openFamily(state, origin);
  try {
    return readProgress(f).api;
  } finally {
    f.close();
  }
}
export function acknowledgeRetentionDependency(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  input: { operationKey: string; fingerprint: string; terminalDigest: string; proofDigest: string },
) {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        dep = p.api,
        fact = Object.values(p.executions).find(
          (e) => e.execution.operationKey === input.operationKey,
        );
      if (
        !dep ||
        dep.operationKey !== input.operationKey ||
        dep.fingerprint !== input.fingerprint ||
        !fact?.terminalDigest ||
        !fact.terminalAt ||
        fact.terminalDigest !== input.terminalDigest
      )
        throw Error("API terminal dependency conflict");
      const payload = apiCopySchema.parse({
        version: 1,
        installationId: f.meta.installationId,
        familyId: f.meta.familyId,
        generation: f.meta.generation,
        originDigest: f.originHash,
        parentDigest: controlDigest(dep.parent),
        ...input,
      });
      const old = apiCopy(f, p);
      if (old) {
        if (controlDigest(old) !== controlDigest(payload))
          throw Error("Conflicting API receipt acknowledgement");
        return;
      }
      if (decision(f).phase !== "active")
        throw Error("Missing committed API acknowledgement proof");
      p.apiAck = { terminalDigest: input.terminalDigest, proofDigest: input.proofDigest };
      progress(f, p);
      cell(
        f.shared,
        "api-ack.json",
        signed(state, "openmapx-retention-api-copy-v1", payload),
        4096,
      );
    });
  } finally {
    f.close();
  }
}
export function hasRetentionEvidence(
  state: InstallationState,
  origin: ControlExecutionOrigin,
): boolean {
  const hash = originHash(origin),
    transaction = json<{ originHash?: string } | null>(
      state.privateRoot,
      "retention-slot-transaction.json",
      4096,
    );
  if (transaction && (transaction.originHash === hash || !transaction.originHash)) return true;
  let locations: AnchoredDirectory | undefined;
  try {
    locations = state.privateRoot.directory("retention-locations");
    locations.fileIdentity(`${hash}.json`);
    return true;
  } catch (error) {
    if (!missing(error)) throw error;
  } finally {
    locations?.close();
  }
  let slots: AnchoredDirectory | undefined;
  try {
    slots = state.privateRoot.directory("retention-families");
    for (let n = 0; n < 1024; n++) {
      let slot: AnchoredDirectory;
      try {
        slot = slots.directory(`slot-${n}`);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      try {
        let id: { originHash: string };
        try {
          id = json(slot, "identity.json", 2048);
        } catch {
          throw Error("Partial family index requires recovery");
        }
        if (!DIGEST.test(id.originHash)) throw Error("Corrupt partial family index");
        if (id.originHash === hash) return true;
      } finally {
        slot.close();
      }
    }
  } catch (error) {
    if (!missing(error)) throw error;
  } finally {
    slots?.close();
  }
  const opened: AnchoredDirectory[] = [];
  const own = (dir: AnchoredDirectory) => {
    opened.push(dir);
    return dir;
  };
  try {
    const root = own(new AnchoredDirectory(state.dataRoot)),
      control = own(root.directory(".admin-target-control"));
    try {
      const families = own(control.directory("retention-families")),
        shared = own(families.directory(hash));
      shared.check();
      return true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    try {
      const executions = own(control.directory("executions")),
        role = own(executions.directory(origin.issuer));
      for (const suffix of [
        ".json",
        ".lifecycle.json",
        ".children.json",
        ".keys.json",
        ".prepared.json",
      ])
        try {
          role.fileIdentity(`${origin.rootKey}${suffix}`);
          return true;
        } catch (error) {
          if (!missing(error)) throw error;
        }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return false;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  } finally {
    for (const dir of opened.reverse()) dir.close();
  }
}
