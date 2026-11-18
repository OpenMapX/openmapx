import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { z } from "zod";
import { controlDigest } from "../build-artifacts/control-records";
import {
  executionAuthorityState,
  fixedChildSpawn,
  type VerifiedExecutionAuthority,
  withPrivateEffectWriter,
} from "../build-artifacts/execution-record";
import { AnchoredDirectory, identity, sameInode } from "../build-artifacts/filesystem";
import {
  closeControlInstallation,
  controlIdentity,
  installationState,
  openControlInstallation,
  readPrivateRecord,
  writePrivateRecord,
} from "../build-artifacts/private-records";
import {
  assertArtifactTargetLeaseContainmentOwner,
  assertArtifactTargetLeaseExecution,
  assertArtifactTargetLeaseReceiptOwner,
  type TargetLeaseAuthority,
} from "../build-artifacts/target-lease";
import { canonicalJson } from "../ops/canonical-json";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import {
  type CoordinatorMode,
  hardlinkApplySummarySchema,
  serviceLifecycleFailureEvidenceSchema,
} from "../ops/service-results";
import {
  assertConfigurationGenerationWriter,
  type ConfigurationGenerationWriter,
  configurationGenerationWriterCommit,
} from "./configuration-generation";

const revision = z
  .string()
  .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
  .nullable();
const ids = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .min(1)
  .max(256)
  .refine((values) => values.every((value, index) => index === 0 || values[index - 1]! < value));
export const serviceLifecycleReceiptSchema = serviceLifecycleFailureEvidenceSchema
  .extend({
    version: z.literal(1),
    execution: executionRefSchema,
    serviceIds: ids,
    action: z.enum(["start", "update"]),
    noDeps: z.boolean(),
    coordinatorMode: z.enum(["ensure-running", "require-running"]),
    hardlinks: hardlinkApplySummarySchema.optional(),
    sequence: z.number().int().nonnegative().safe(),
  })
  .superRefine((value, context) => {
    if (
      (value.commit === "not_committed" && (value.seedRevisionId || value.finalRevisionId)) ||
      (value.commit === "seed_committed" && !value.seedRevisionId) ||
      (value.commit === "final_committed" && !value.finalRevisionId) ||
      (value.phase === "complete" &&
        (!value.finalRevisionId ||
          value.commit !== "final_committed" ||
          value.followUp !== "complete" ||
          !value.hardlinks?.applied ||
          value.failure))
    )
      context.addIssue({ code: "custom", message: "Inconsistent lifecycle evidence" });
  });
export type ServiceLifecycleReceipt = z.infer<typeof serviceLifecycleReceiptSchema>;
declare const ownershipBrand: unique symbol;
export type VerifiedLifecycleOwnership = Readonly<{
  writer: ConfigurationGenerationWriter;
  lease: TargetLeaseAuthority;
  [ownershipBrand]: true;
}>;
const ownerships = new WeakMap<VerifiedLifecycleOwnership, VerifiedExecutionAuthority>();
const authorities = new AsyncLocalStorage<{
  authority: VerifiedExecutionAuthority;
  child?: { execution: ExecutionRef; childKey: string };
}>();

/** Source-only scope: child identity is checked against its existing private spawn challenge. */
export function withServiceLifecycleReceiptAuthority<T>(
  authority: VerifiedExecutionAuthority,
  run: () => Promise<T>,
  child?: { execution: ExecutionRef; childKey: string },
): Promise<T> {
  const state = executionAuthorityState(authority);
  if (child) {
    const spawn = fixedChildSpawn(state.installation, child.childKey, child.execution);
    if (controlDigest(spawn.parent) !== controlDigest(authority.execution))
      throw Error("Lifecycle child challenge mismatch");
  }
  return authorities.run({ authority, child }, run);
}
export async function withVerifiedLifecycleOwnership<T>(
  options: {
    writer: ConfigurationGenerationWriter;
    lease: TargetLeaseAuthority;
    authority: VerifiedExecutionAuthority;
  },
  run: (ownership: VerifiedLifecycleOwnership) => Promise<T>,
): Promise<T> {
  assertConfigurationGenerationWriter(options.writer);
  assertArtifactTargetLeaseExecution(options.lease, options.authority.execution);
  executionAuthorityState(options.authority);
  const ownership = Object.freeze({
    writer: options.writer,
    lease: options.lease,
  }) as VerifiedLifecycleOwnership;
  ownerships.set(ownership, options.authority);
  try {
    return await withServiceLifecycleReceiptAuthority(options.authority, () => run(ownership));
  } finally {
    ownerships.delete(ownership);
  }
}
export function assertVerifiedLifecycleOwnership(
  ownership: VerifiedLifecycleOwnership,
): VerifiedExecutionAuthority {
  const authority = ownerships.get(ownership);
  if (!authority) throw Error("Lifecycle ownership is unavailable");
  assertConfigurationGenerationWriter(ownership.writer);
  assertArtifactTargetLeaseReceiptOwner(ownership.lease, authority.execution);
  executionAuthorityState(authority);
  return authority;
}

const seedSchema = z.strictObject({
  version: z.literal(1),
  issuer: z.enum(["ops-agent", "host-cli"]),
  root: executionRefSchema,
  execution: executionRefSchema,
  serviceIds: ids,
  action: z.enum(["start", "update"]),
  noDeps: z.boolean(),
  coordinatorMode: z.enum(["ensure-running", "require-running"]),
  expectedRevisionId: revision,
  seedRevisionId: revision,
  childId: z.string().min(1).max(256),
});
const envelopeSchema = z.strictObject({
  seed: seedSchema,
  current: z.strictObject({
    seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receipt: serviceLifecycleReceiptSchema,
  }),
});
const highWaterSchema = z.strictObject({
  version: z.literal(1),
  execution: executionRefSchema,
  seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().nonnegative().safe(),
  receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  signer: z.enum(["seed", "child"]),
  pending: z
    .strictObject({
      sequence: z.number().int().positive().safe(),
      receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
});
const highWaterName = (execution: ExecutionRef) =>
  `lifecycle-${executionRefSchema.parse(execution).operationKey}.json`;
function assertDataRoot(dataRoot: string, trusted: string) {
  const supplied = new AnchoredDirectory(dataRoot),
    expected = new AnchoredDirectory(trusted);
  try {
    if (!sameInode(identity(supplied.stat), identity(expected.stat)))
      throw Error("Foreign lifecycle data root");
  } finally {
    supplied.close();
    expected.close();
  }
}
/** Receipts live in the agent's own state, which data-manager does not mount. */
function directories(dataRoot: string) {
  const root = new AnchoredDirectory(join(dirname(dataRoot), "state"));
  const agent = root.directory("ops-agent", true, true),
    directory = agent.directory("lifecycle", true, true);
  return {
    directory,
    close() {
      directory.close();
      agent.close();
      root.close();
    },
  };
}
function same(value: unknown, other: unknown) {
  return canonicalJson(value) === canonicalJson(other);
}
function readEnvelope(dataRoot: string, execution: ExecutionRef) {
  const opened = directories(dataRoot);
  try {
    return envelopeSchema.parse(
      JSON.parse(
        opened.directory
          .read(`${executionRefSchema.parse(execution).operationKey}.json`, 65536)
          .toString("utf8"),
      ),
    );
  } finally {
    opened.close();
  }
}
function inspect(dataRoot: string, execution: ExecutionRef, allowRecovery = false) {
  const envelope = readEnvelope(dataRoot, execution),
    scope = authorities.getStore();
  let close: (() => void) | undefined;
  const local = scope
    ? executionAuthorityState(scope.authority).installation
    : (() => {
        const installation = openControlInstallation({
          infraDir: dirname(dataRoot),
          role: envelope.seed.issuer,
        });
        close = () => closeControlInstallation(installation);
        return installationState(installation);
      })();
  try {
    assertDataRoot(dataRoot, local.dataRoot);
    const seed = seedSchema.parse(envelope.seed);
    const seedDigest = controlDigest(envelope.seed);
    const current = envelopeSchema.shape.current.parse(envelope.current);
    const raw = readPrivateRecord(local, "observations", highWaterName(execution), 8192);
    let water = highWaterSchema.parse(raw);
    const receipt = current.receipt;
    if (
      !same(seed.execution, execution) ||
      !same(receipt.execution, execution) ||
      !same(water.execution, execution) ||
      current.seedDigest !== seedDigest ||
      water.seedDigest !== seedDigest ||
      !same(seed.serviceIds, receipt.serviceIds) ||
      seed.action !== receipt.action ||
      seed.noDeps !== receipt.noDeps ||
      seed.coordinatorMode !== receipt.coordinatorMode ||
      seed.expectedRevisionId !== receipt.expectedRevisionId ||
      seed.seedRevisionId !== receipt.seedRevisionId
    )
      throw Error("Lifecycle receipt is unavailable");
    if (water.pending && allowRecovery && scope) {
      const owner = executionAuthorityState(scope.authority),
        pending = water.pending;
      if (
        !same(owner.execution, execution) ||
        owner.kind !== `service.${seed.action}` ||
        controlIdentity(owner.installation.installation) !== seed.childId ||
        water.signer !== "child" ||
        pending.sequence !== water.sequence + 1 ||
        receipt.sequence !== pending.sequence ||
        controlDigest(envelope.current) !== pending.receiptDigest
      )
        throw Error("Lifecycle publication requires reconciliation");
      const repaired = {
        ...water,
        sequence: pending.sequence,
        receiptDigest: pending.receiptDigest,
        pending: null,
      };
      withPrivateEffectWriter(owner, () => {
        if (
          controlDigest(
            readPrivateRecord(local, "observations", highWaterName(execution), 8192),
          ) !== controlDigest(raw) ||
          controlDigest(readEnvelope(dataRoot, execution)) !== controlDigest(envelope)
        )
          throw Error("Lifecycle publication changed during recovery");
        writePrivateRecord(local, "observations", highWaterName(execution), repaired, false);
      });
      water = repaired;
    }
    if (
      water.pending ||
      water.sequence !== receipt.sequence ||
      water.receiptDigest !== controlDigest(envelope.current)
    )
      throw Error("Lifecycle receipt is unavailable");
    return { envelope, seed, receipt, water, local };
  } finally {
    close?.();
  }
}
export interface ServiceLifecycleReceiptStore {
  read(): Promise<ServiceLifecycleReceipt>;
  checkpoint(
    expectedSequence: number,
    receipt: ServiceLifecycleReceipt,
    ownership: VerifiedLifecycleOwnership,
  ): Promise<void>;
  /**
   * Records why a lifecycle stopped when its lease can no longer take ownership,
   * as after cancellation or expiry. Accepts only the failed and unknown phases.
   */
  recordContainment(
    expectedSequence: number,
    receipt: ServiceLifecycleReceipt,
    owner: {
      writer: ConfigurationGenerationWriter;
      lease: TargetLeaseAuthority;
      authority: VerifiedExecutionAuthority;
    },
  ): Promise<void>;
}
export async function openServiceLifecycleReceipt(options: {
  dataRoot: string;
  execution: ExecutionRef;
  serviceIds: readonly string[];
  action: "start" | "update";
  noDeps: boolean;
  coordinatorMode: CoordinatorMode;
  expectedRevisionId: string | null;
  seedRevisionId: string | null;
}): Promise<ServiceLifecycleReceiptStore> {
  const scope = authorities.getStore();
  if (!scope) throw Error("Lifecycle receipt owner is required");
  const state = executionAuthorityState(scope.authority),
    local = state.installation;
  assertDataRoot(options.dataRoot, local.dataRoot);
  if (!same(options.execution, scope.child?.execution ?? scope.authority.execution))
    throw Error("Lifecycle receipt execution mismatch");
  const admitted = readPrivateRecord(
    local,
    "executions",
    `${state.execution.operationKey}.json`,
    65536,
  ) as {
    operation: {
      kind: string;
      serviceId?: string;
      expectedConfigurationRevisionId?: string;
      noDeps?: boolean;
    };
  };
  const operation = admitted.operation;
  if (
    operation.kind !== `service.${options.action}` ||
    !operation.serviceId ||
    !options.serviceIds.includes(operation.serviceId) ||
    options.serviceIds.some((id) => !state.serviceIds.includes(id)) ||
    options.noDeps !== (operation.noDeps ?? false) ||
    options.expectedRevisionId !== operation.expectedConfigurationRevisionId ||
    options.coordinatorMode !== "ensure-running"
  )
    throw Error("Lifecycle seed does not match admitted operation");
  const opened = directories(options.dataRoot),
    name = `${executionRefSchema.parse(options.execution).operationKey}.json`;
  try {
    let exists = true;
    try {
      opened.directory.fileIdentity(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
      else throw error;
    }
    if (!exists) {
      if (local.fixedChildId) throw Error("Agent seed receipt is missing");
      try {
        readPrivateRecord(local, "observations", highWaterName(options.execution), 8192);
        throw Error("Lifecycle receipt initialization is unresolved");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (opened.directory.listBounded(129).length >= 128)
        throw Error("Lifecycle receipt capacity unavailable");
      const serviceIds = [...new Set(options.serviceIds)].sort();
      const receipt = serviceLifecycleReceiptSchema.parse({
        version: 1,
        execution: options.execution,
        serviceIds,
        action: options.action,
        noDeps: options.noDeps,
        coordinatorMode: options.coordinatorMode,
        expectedRevisionId: options.expectedRevisionId,
        seedRevisionId: options.seedRevisionId,
        finalRevisionId: null,
        phase: "prepared",
        commit: options.seedRevisionId ? "seed_committed" : "not_committed",
        followUp: "not_started",
        sequence: 0,
      });
      const seed = seedSchema.parse({
        version: 1,
        issuer: local.installation.role,
        root: scope.authority.execution,
        execution: options.execution,
        serviceIds,
        action: options.action,
        noDeps: options.noDeps,
        coordinatorMode: options.coordinatorMode,
        expectedRevisionId: options.expectedRevisionId,
        seedRevisionId: options.seedRevisionId,
        childId: scope.child?.childKey ?? controlIdentity(local.installation),
      });
      const seedDigest = controlDigest(seed),
        current = { seedDigest, receipt };
      const envelope = envelopeSchema.parse({ seed, current }),
        bytes = canonicalJson(envelope);
      if (Buffer.byteLength(bytes) > 65536) throw Error("Lifecycle receipt budget exceeded");
      writePrivateRecord(
        local,
        "observations",
        highWaterName(options.execution),
        {
          version: 1,
          execution: options.execution,
          seedDigest,
          sequence: 0,
          receiptDigest: controlDigest(current),
          signer: "seed",
          pending: null,
        },
        true,
      );
      opened.directory.write(name, bytes, true);
    }
  } finally {
    opened.close();
  }
  const existing = inspect(options.dataRoot, options.execution).receipt;
  if (
    !same(existing.serviceIds, [...new Set(options.serviceIds)].sort()) ||
    existing.action !== options.action ||
    existing.noDeps !== options.noDeps ||
    existing.coordinatorMode !== options.coordinatorMode ||
    existing.expectedRevisionId !== options.expectedRevisionId ||
    existing.seedRevisionId !== options.seedRevisionId
  )
    throw Error("Lifecycle receipt identity conflict");
  const write = (
    expectedSequence: number,
    next: ServiceLifecycleReceipt,
    writer: ConfigurationGenerationWriter,
    lease: TargetLeaseAuthority,
    authority: VerifiedExecutionAuthority,
  ) => {
    const owner = executionAuthorityState(authority);
    return withPrivateEffectWriter(owner, () => {
      const current = inspect(options.dataRoot, options.execution);
      const receipt = serviceLifecycleReceiptSchema.parse(next);
      const transitions: Record<
        ServiceLifecycleReceipt["phase"],
        readonly ServiceLifecycleReceipt["phase"][]
      > = {
        prepared: ["pins_validated"],
        pins_validated: [receipt.action === "update" ? "pulled" : "generation_committed"],
        pulled: ["generation_committed"],
        generation_committed: ["hardlinks_applied"],
        hardlinks_applied: ["recreated"],
        recreated: ["complete"],
        complete: [],
        failed: [],
        unknown: [],
      };
      if (
        !["failed", "unknown"].includes(receipt.phase) &&
        !transitions[current.receipt.phase].includes(receipt.phase)
      )
        throw Error("Lifecycle phase transition conflict");
      if (
        receipt.finalRevisionId !== null &&
        current.receipt.finalRevisionId === null &&
        configurationGenerationWriterCommit(writer)?.revisionId !== receipt.finalRevisionId
      )
        throw Error("Lifecycle revision was not committed by its writer");
      if (current.receipt.commit === "final_committed" && receipt.commit !== "final_committed")
        throw Error("Lifecycle commit evidence cannot regress");
      if (!["failed", "unknown"].includes(receipt.phase))
        assertArtifactTargetLeaseExecution(lease, authority.execution);
      if (
        !same(authority.execution, receipt.execution) ||
        controlIdentity(owner.installation.installation) !== current.seed.childId ||
        expectedSequence !== current.receipt.sequence ||
        receipt.sequence !== expectedSequence + 1 ||
        ["complete", "failed", "unknown"].includes(current.receipt.phase) ||
        !same(receipt.execution, current.receipt.execution) ||
        !same(receipt.serviceIds, current.receipt.serviceIds) ||
        receipt.action !== current.receipt.action ||
        receipt.noDeps !== current.receipt.noDeps ||
        receipt.coordinatorMode !== current.receipt.coordinatorMode ||
        receipt.expectedRevisionId !== current.receipt.expectedRevisionId ||
        receipt.seedRevisionId !== current.receipt.seedRevisionId ||
        (current.receipt.finalRevisionId !== null &&
          current.receipt.finalRevisionId !== receipt.finalRevisionId)
      )
        throw Error("Lifecycle receipt checkpoint conflict");
      const record = {
        seedDigest: controlDigest(current.envelope.seed),
        receipt,
      };
      const envelope = { seed: current.envelope.seed, current: record },
        bytes = canonicalJson(envelope);
      if (Buffer.byteLength(bytes) > 65536) throw Error("Lifecycle receipt budget exceeded");
      const directory = directories(options.dataRoot);
      try {
        const before = directory.directory.fileIdentity(name);
        const pending = {
          ...current.water,
          signer: "child" as const,
          pending: { sequence: receipt.sequence, receiptDigest: controlDigest(record) },
        };
        writePrivateRecord(
          owner.installation,
          "observations",
          highWaterName(options.execution),
          pending,
          false,
        );
        directory.directory.write(name, bytes, false, () => {
          assertConfigurationGenerationWriter(writer);
          if (!sameInode(before, directory.directory.fileIdentity(name)))
            throw Error("Lifecycle receipt inode changed");
        });
        writePrivateRecord(
          owner.installation,
          "observations",
          highWaterName(options.execution),
          {
            ...pending,
            sequence: receipt.sequence,
            receiptDigest: controlDigest(record),
            pending: null,
          },
          false,
        );
      } finally {
        directory.close();
      }
    });
  };
  return {
    async read() {
      return readServiceLifecycleReceipt(options);
    },
    async checkpoint(expectedSequence, next, ownership) {
      const authority = assertVerifiedLifecycleOwnership(ownership);
      return write(expectedSequence, next, ownership.writer, ownership.lease, authority);
    },
    async recordContainment(expectedSequence, next, { writer, lease, authority }) {
      if (!["failed", "unknown"].includes(next.phase))
        throw Error("Lifecycle containment records only failed or unknown phases");
      assertConfigurationGenerationWriter(writer);
      assertArtifactTargetLeaseContainmentOwner(lease, authority.execution);
      await withServiceLifecycleReceiptAuthority(authority, async () =>
        write(expectedSequence, next, writer, lease, authority),
      );
    },
  };
}
export async function readServiceLifecycleReceipt(options: {
  dataRoot: string;
  execution: ExecutionRef;
}): Promise<ServiceLifecycleReceipt> {
  return inspect(options.dataRoot, executionRefSchema.parse(options.execution), true).receipt;
}

/**
 * Whether a recorded failure can be released by the process that recorded it.
 * Docker effects are awaited children, so once one has exited no writer of ours
 * survives; only a hardlink application data-manager never answered for can
 * still be running, and that keeps the fence.
 */
export function lifecycleFailureHasNoSurvivor(
  receipt: ServiceLifecycleReceipt,
  hardlinkOutcomeUnknown: boolean,
): boolean {
  return (receipt.phase === "failed" || receipt.phase === "unknown") && !hardlinkOutcomeUnknown;
}

function readOriginalStandaloneReceipt(authority: VerifiedExecutionAuthority) {
  const owner = executionAuthorityState(authority);
  if (
    owner.installation.installation.role !== "host-cli" ||
    owner.installation.fixedChildId ||
    !["service.start", "service.update"].includes(owner.kind) ||
    owner.execution.executor !== "host-cli"
  )
    throw Error("Original standalone host lifecycle required");
  return authorities.run(
    { authority },
    () => inspect(owner.installation.dataRoot, owner.execution, true).receipt,
  );
}

/** The original producer's durable failure or unknown outcome, at any phase it stopped. */
export function readFailedServiceLifecycleReceipt(authority: VerifiedExecutionAuthority) {
  const receipt = readOriginalStandaloneReceipt(authority);
  if (!lifecycleFailureHasNoSurvivor(receipt, false))
    throw Error("Original failed lifecycle required");
  return receipt;
}

/** Original producer evidence only; never accepts a caller-supplied receipt. */
export function readFailedServiceHardlinksReceipt(authority: VerifiedExecutionAuthority) {
  const receipt = readOriginalStandaloneReceipt(authority);
  if (
    receipt.phase !== "failed" ||
    receipt.failure?.reason !== "hardlinks" ||
    receipt.commit !== "final_committed" ||
    !receipt.finalRevisionId ||
    receipt.followUp !== "unknown" ||
    receipt.hardlinks
  )
    throw Error("Original failure before hardlink completion required");
  return receipt;
}
