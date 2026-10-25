/** Fixed service-only configuration/feed guard; signatures are verified against
 * the anchored original agent grant, never against the shared bearer alone. */
import { z } from "zod";
import { executionFingerprint, executionRefSchema } from "../ops/execution-identity";
import { canonicalJson } from "../ops/fingerprint";
import {
  type DataConfigurationFencePrepare,
  type DataConfigurationFenceReceipt,
  type DataConfigurationFenceSettle,
  dataConfigurationFencePrepareSchema,
  dataConfigurationFenceReceiptSchema,
  dataConfigurationFenceSettleSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import { startGenerationHardlinksExecutionSchema } from "../services/data-manager/contracts/executions";
import {
  beginControlEffect,
  type ControlInstallation,
  controlDigest,
  controlHeaders,
  executionAuthorityState,
  installationState,
  readPrivateRecord,
  requireControlJournalRetention,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainedControlParent,
  settleExecutionLifecycle,
  verifyControlEffectSettlement,
  verifyControlPeer,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "./control-authority";
import { controlOriginSchema, signControl, verifyControl } from "./control-records";
import { retainedDataDatabaseTimestamp } from "./data-database-time";
import { verifiedParentForArtifactDelegation } from "./peer-admission";
import {
  completeFamilyJournal,
  markFamilyTerminal,
  publishFamilyCanonicalTerminal,
  verifyFamilyOwnedRecord,
} from "./retention-family";
import {
  adoptArtifactTargetLease,
  assertArtifactTargetLeaseForward,
  bindBorrowedControlExecution,
  closeArtifactTargetLeaseHandle,
  inspectArtifactDelegation,
  settleArtifactTargetLeaseChild,
  verifyRetainedArtifactTargetSettlement,
} from "./target-lease";
export interface DataFenceSql {
  unsafe(
    query: string,
    parameters?: (string | number | null)[],
  ): Promise<readonly Record<string, unknown>[]>;
  transaction<T>(run: (tx: Pick<DataFenceSql, "unsafe">) => Promise<T>): Promise<T>;
}
const metadataSchema = z.strictObject({
  version: z.literal(1),
  guardState: z.enum(["preparing", "prepared", "settling", "settled", "recovery_required"]),
  receipt: dataConfigurationFenceReceiptSchema,
  input: dataConfigurationFencePrepareSchema,
  settlement: dataConfigurationFenceSettleSchema.optional(),
});
const mirrorSchema = z.strictObject({
  preparedAt: z.number().int().positive().safe(),
  ownerCertificateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  prepareAssertion: z.string().max(4096),
  version: z.literal(1),
  installationId: z.uuid(),
  origin: controlOriginSchema,
  metadata: metadataSchema,
});
const fenceTerminalSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["prepared", "canonical"]),
  execution: executionRefSchema,
  admissionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  terminalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  terminalAt: z.number().int().positive().safe(),
});
const inspectWitnessSchema = z.strictObject({
  installationId: z.uuid(),
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  ownerCertificateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});
export class DataFenceBusy extends Error {
  readonly statusCode = 409;
  constructor() {
    super("configuration_maintenance_busy");
  }
}
export function createDataConfigurationFenceStore(
  installation: ControlInstallation,
  sql: DataFenceSql,
) {
  const local = installationState(installation);
  if (installation.role !== "data-manager" || local.fixedChildId)
    throw Error("Fixed DM fence receiver required");
  let startup = "closed" as "closed" | "open" | "fenced";
  const mirrors = new Map<string, z.infer<typeof mirrorSchema>>();
  function mirror(id: string) {
    const raw = readPrivateRecord(
        local,
        "configuration-maintenance",
        `${z.uuid().parse(id)}.json`,
        65536,
      ),
      parsed = verifyControl(
        installation.publicKey,
        "openmapx-data-configuration-fence-v1",
        raw,
        mirrorSchema,
      );
    verifyFamilyOwnedRecord(
      local,
      parsed.origin,
      {
        scope: "private",
        namespace: "configuration-maintenance",
        name: `${id}.json`,
        container: "",
      },
      canonicalJson(raw),
    );
    if (
      parsed.installationId !== installation.installationId ||
      parsed.metadata.receipt.maintenanceId !== id
    )
      throw Error("Configuration guard mirror identity changed");
    return parsed;
  }
  function write(value: z.infer<typeof mirrorSchema>) {
    const parsed = mirrorSchema.parse(value);
    writePrivateRecord(
      local,
      "configuration-maintenance",
      `${parsed.metadata.receipt.maintenanceId}.json`,
      signControl(local.privateKey, "openmapx-data-configuration-fence-v1", parsed),
      false,
      parsed.origin,
    );
    mirrors.set(parsed.metadata.receipt.maintenanceId, parsed);
  }
  async function lock(tx: Pick<DataFenceSql, "unsafe">) {
    const rows = await tx.unsafe(
      "SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS held",
      [0x4f4d58, 2],
    );
    if (rows[0]?.held !== true) throw new DataFenceBusy();
  }
  async function row(tx: Pick<DataFenceSql, "unsafe">, id: string) {
    const rows = await tx.unsafe(
      "SELECT id,metadata FROM data_manager.jobs WHERE kind='configuration-maintenance' AND metadata->'configurationMaintenance'->'receipt'->>'maintenanceId'=$1",
      [id],
    );
    if (rows.length > 1) throw Error("Duplicate configuration fence");
    if (!rows[0]) return null;
    return metadataSchema.parse(
      z.object({ configurationMaintenance: metadataSchema }).parse(rows[0].metadata)
        .configurationMaintenance,
    );
  }
  function inspectGrant(
    body: DataConfigurationFencePrepare | DataConfigurationFenceSettle,
    rawHeaders: readonly string[],
    kind: "configuration-maintenance.prepare" | "configuration-maintenance.settle",
    owner?: DataConfigurationFencePrepare,
  ) {
    const headers = controlHeaders(rawHeaders);
    if (!headers.delegation || headers.parent) throw Error("Pinned agent fence grant required");
    const grant = inspectArtifactDelegation({
      dataRoot: local.dataRoot,
      assertion: headers.delegation,
      installation,
    });
    const operation = { kind, ...body },
      parent = "ownerPrepare" in body ? body.ownerPrepare : owner?.ownerPrepare;
    if (
      grant.recipient !== "data-manager" ||
      grant.parent.executor !== "ops-agent" ||
      grant.kind !== kind ||
      grant.phase !==
        (kind.endsWith(".prepare") ? "configuration-fence" : "configuration-fence-settle") ||
      !parent ||
      controlDigest(grant.parent) !== controlDigest(parent) ||
      grant.execution.operationFingerprint !== controlDigest(operation) ||
      grant.execution.executor !== "data-manager" ||
      grant.execution.fingerprint !==
        executionFingerprint({
          kind,
          operationFingerprint: controlDigest(operation),
          deadlineAt: grant.execution.deadlineAt,
          parent: retainedControlParent(grant.parent),
        })
    )
      throw Error("Configuration fence grant identity conflict");
    if ("serviceIds" in body && canonicalJson(grant.serviceIds) !== canonicalJson(body.serviceIds))
      throw Error("Configuration fence target subset conflict");
    const peer = verifyControlPeer(installation, {
      rawHeaders,
      transportPrincipal: "shared-data-manager-bearer",
      execution: grant.execution,
      kind,
    });
    return {
      grant,
      peer,
      operation,
      parent: verifiedParentForArtifactDelegation(
        installation,
        headers.delegation,
        grant.execution,
      ),
      assertion: headers.delegation,
    };
  }
  async function withLeaf(
    verified: ReturnType<typeof inspectGrant>,
    run: (
      authority: import("./control-authority").VerifiedExecutionAuthority,
    ) => Promise<DataConfigurationFenceReceipt>,
  ) {
    const { grant, peer } = verified;
    const lease = await adoptArtifactTargetLease({
      dataRoot: local.dataRoot,
      assertion: verified.assertion,
      peer,
      execution: grant.execution,
      serviceIds: grant.serviceIds,
    });
    try {
      const admittedAt = Date.now();
      let authority: ReturnType<typeof restoreAdmittedControlExecution> | undefined;
      try {
        authority = restoreAdmittedControlExecution(installation, grant.execution);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      authority ??= retainAdmittedControlExecution(installation, {
        execution: grant.execution,
        kind: grant.kind,
        operation: verified.operation,
        admittedAt,
        requestedDeadlineAt: grant.execution.deadlineAt,
        parent: verified.parent,
        serviceIds: grant.serviceIds,
      });
      bindBorrowedControlExecution(lease, authority);
      let priorEffect: unknown;
      try {
        priorEffect = readPrivateRecord(
          local,
          "effects",
          `${grant.execution.operationKey}.json`,
          65536,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (priorEffect !== undefined && priorEffect !== null) {
        verifyRetainedArtifactTargetSettlement(
          installation,
          { leaseId: grant.leaseId, delegationId: grant.delegationId, phase: "ready" },
          grant.execution,
        );
        const kind = z
          .object({ payload: z.object({ receipt: z.object({ kind: z.string() }) }) })
          .parse(priorEffect).payload.receipt.kind;
        if (kind === "data-configuration-fence-refused") {
          verifyControlEffectSettlement(installation, grant.execution);
          throw new DataFenceBusy();
        }
        const original = verifyControl(
          installation.publicKey,
          "openmapx-control-settlement-v1",
          priorEffect,
          z
            .object({
              receipt: z
                .object({
                  kind: z.literal("data-configuration-fence"),
                  receipt: dataConfigurationFenceReceiptSchema,
                })
                .passthrough(),
            })
            .passthrough(),
        );
        const saved = await row(sql, original.receipt.receipt.maintenanceId);
        if (!saved) throw new DataFenceBusy();
        return saved.receipt;
      }
      if (grant.kind === "configuration-maintenance.prepare")
        requireControlJournalRetention(authority);
      if (grant.kind === "configuration-maintenance.prepare")
        assertArtifactTargetLeaseForward(lease);
      beginControlEffect(authority);
      let receipt: DataConfigurationFenceReceipt;
      try {
        receipt = await run(authority);
      } catch (error) {
        // Before any preparing mirror exists the fixed guard path has made
        // no logical write. A busy result can settle this exact unused leaf.
        if (error instanceof DataFenceBusy) {
          let absent = false;
          try {
            readPrivateRecord(
              local,
              "configuration-maintenance",
              `${z.object({ maintenanceId: z.uuid() }).parse(verified.operation).maintenanceId}.json`,
              65536,
            );
          } catch (missing) {
            absent = (missing as NodeJS.ErrnoException).code === "ENOENT";
          }
          if (
            absent &&
            !(await row(
              sql,
              z.object({ maintenanceId: z.uuid() }).parse(verified.operation).maintenanceId,
            ))
          ) {
            const state = executionAuthorityState(authority),
              observation = {
                kind: "data-configuration-fence-refused" as const,
                maintenanceId: z.object({ maintenanceId: z.uuid() }).parse(verified.operation)
                  .maintenanceId,
                reason: "busy" as const,
              },
              effect = {
                identity: grant.execution,
                outcome: "failed_without_effect" as const,
                publication: "not_started" as const,
                terminalReceiptDigest: controlDigest(observation),
                receipt: observation,
              };
            const terminalAt = Date.now(),
              terminalDigest = controlDigest({ version: 1, refused: observation });
            withPrivateEffectWriter(state, () => {
              writePrivateRecord(
                local,
                "observations",
                `terminal-${grant.execution.operationKey}.json`,
                signControl(
                  local.privateKey,
                  "openmapx-data-fence-terminal-v1",
                  fenceTerminalSchema.parse({
                    version: 1,
                    phase: "canonical",
                    execution: grant.execution,
                    admissionDigest: state.receiptDigest,
                    terminalDigest,
                    terminalAt,
                  }),
                ),
                false,
                state.origin,
              );
              settleExecutionLifecycle(state);
              writePrivateRecord(
                local,
                "effects",
                `${grant.execution.operationKey}.json`,
                signControl(local.privateKey, "openmapx-control-settlement-v1", effect),
                false,
                state.origin,
              );
              if (state.origin)
                markFamilyTerminal(
                  local,
                  state.origin,
                  grant.execution,
                  true,
                  controlDigest(effect),
                );
            });
            await settleArtifactTargetLeaseChild(
              lease,
              verifyControlEffectSettlement(installation, grant.execution),
            );
            if (state.origin) {
              publishFamilyCanonicalTerminal(
                local,
                state.origin,
                grant.execution,
                true,
                terminalDigest,
                terminalAt,
              );
              completeFamilyJournal(local, state.origin, grant.execution, terminalAt);
            }
          }
        }
        throw error;
      }
      const state = executionAuthorityState(authority),
        stored = mirror(receipt.maintenanceId);
      if (controlDigest(stored.metadata.receipt) !== controlDigest(receipt))
        throw Error("Durable fence receipt changed before settlement");
      withPrivateEffectWriter(state, () => {
        const proof = {
            kind: "data-configuration-fence" as const,
            receipt,
            guardDigest: controlDigest(stored),
          },
          effect = {
            identity: grant.execution,
            outcome: "committed" as const,
            publication: "committed" as const,
            terminalReceiptDigest: controlDigest(proof),
            receipt: proof,
          };
        settleExecutionLifecycle(state);
        writePrivateRecord(
          local,
          "effects",
          `${grant.execution.operationKey}.json`,
          signControl(local.privateKey, "openmapx-control-settlement-v1", effect),
          false,
          state.origin,
        );
        if (state.origin)
          markFamilyTerminal(local, state.origin, grant.execution, true, controlDigest(effect));
      });
      await settleArtifactTargetLeaseChild(
        lease,
        verifyControlEffectSettlement(installation, grant.execution),
      );
      if (grant.kind === "configuration-maintenance.prepare" && state.origin) {
        const digest = dataFenceTerminalDigest(receipt),
          original = verifyControl(
            installation.publicKey,
            "openmapx-data-fence-terminal-v1",
            readPrivateRecord(
              local,
              "observations",
              `terminal-${grant.execution.operationKey}.json`,
              8192,
            ),
            fenceTerminalSchema,
          );
        if (
          original.terminalDigest !== digest ||
          original.terminalAt !== stored.preparedAt ||
          original.admissionDigest !== state.receiptDigest
        )
          throw Error("Original logical guard terminal commitment changed");
        writePrivateRecord(
          local,
          "observations",
          `terminal-${grant.execution.operationKey}.json`,
          signControl(local.privateKey, "openmapx-data-fence-terminal-v1", {
            ...original,
            phase: "canonical",
          }),
          false,
          state.origin,
        );
        publishFamilyCanonicalTerminal(
          local,
          state.origin,
          grant.execution,
          true,
          digest,
          stored.preparedAt,
        );
        completeFamilyJournal(local, state.origin, grant.execution, stored.preparedAt);
      }
      return receipt;
    } finally {
      closeArtifactTargetLeaseHandle(lease);
    }
  }
  async function assertAdmission(tx: Pick<DataFenceSql, "unsafe">) {
    if (
      startup === "closed" ||
      [...mirrors.values()].some((value) => value.metadata.guardState !== "settled")
    )
      throw new DataFenceBusy();
    const rows = await tx.unsafe(
      "SELECT id FROM data_manager.jobs WHERE kind='configuration-maintenance' AND coalesce(metadata->'configurationMaintenance'->>'guardState','recovery_required') <> 'settled' LIMIT 1",
    );
    if (rows.length) throw new DataFenceBusy();
    const unknown = await tx.unsafe(
      "SELECT id FROM data_manager.jobs WHERE kind <> 'configuration-maintenance' AND (execution_state->>'publication'='unknown' OR (execution_version IS NULL AND finished_at IS NULL AND status='interrupted')) LIMIT 1",
    );
    if (unknown.length) throw new DataFenceBusy();
  }
  return {
    async startup() {
      startup = "closed";
      mirrors.clear();
      let directory: ReturnType<typeof local.privateRoot.directory> | undefined;
      try {
        directory = local.privateRoot.directory("configuration-maintenance");
        for (const file of directory.listBounded(4097)) {
          if ([".retention-count", ".retention-highwater", ".retention-transaction"].includes(file))
            continue;
          if (!/^[a-f0-9-]{36}\.json$/.test(file))
            throw Error("Unexpected configuration fence file");
          const value = mirror(file.slice(0, -5));
          mirrors.set(value.metadata.receipt.maintenanceId, value);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        directory?.close();
      }
      const rows = await sql.unsafe(
        "SELECT metadata FROM data_manager.jobs WHERE kind='configuration-maintenance' AND coalesce(metadata->'configurationMaintenance'->>'guardState','recovery_required') <> 'settled' LIMIT 2",
      );
      if (rows.length > 1) throw Error("Conflicting configuration guards");
      for (const raw of rows) {
        const value = z
            .object({ configurationMaintenance: metadataSchema })
            .parse(raw.metadata).configurationMaintenance,
          saved = mirrors.get(value.receipt.maintenanceId);
        if (!saved || canonicalJson(saved.metadata) !== canonicalJson(value))
          throw Error("Configuration guard mirror/database recovery required");
      }
      for (const value of mirrors.values())
        if (value.metadata.guardState !== "settled") {
          const saved = await row(sql, value.metadata.receipt.maintenanceId);
          if (!saved || canonicalJson(saved) !== canonicalJson(value.metadata))
            throw Error("Half-written configuration guard retains admission fence");
        }
      startup = rows.length ? "fenced" : "open";
    },
    assertAdmission,
    async assertGenerationAdmission(value: unknown, rawHeaders: readonly string[]): Promise<void> {
      const request = startGenerationHardlinksExecutionSchema.parse(value),
        headers = controlHeaders(rawHeaders);
      if (!headers.delegation || headers.parent)
        throw Object.assign(Error("Signed generation grant required"), { statusCode: 403 });
      const grant = inspectArtifactDelegation({
        dataRoot: local.dataRoot,
        assertion: headers.delegation,
        installation,
      });
      if (
        grant.recipient !== "data-manager" ||
        grant.kind !== "generation-hardlinks" ||
        grant.phase !== "hardlinks" ||
        grant.execution.operationKey !== request.operationKey ||
        grant.execution.operationFingerprint !== controlDigest(request.input) ||
        request.input.planDigest !== controlDigest(request.plan) ||
        request.plan.plan.some((entry) => !grant.serviceIds.includes(entry.consumerService))
      )
        throw Object.assign(Error("Generation plan/grant binding conflict"), { statusCode: 403 });
      if (startup === "closed") throw new DataFenceBusy();
      const rows = await sql.unsafe(
        "SELECT metadata FROM data_manager.jobs WHERE kind='configuration-maintenance' AND coalesce(metadata->'configurationMaintenance'->>'guardState','recovery_required') <> 'settled' LIMIT 2",
      );
      if (rows.length > 1) throw new DataFenceBusy();
      const saved = rows[0]
        ? z.object({ configurationMaintenance: metadataSchema }).parse(rows[0].metadata)
            .configurationMaintenance
        : undefined;
      if (!saved) {
        if ([...mirrors.values()].some((mirror) => mirror.metadata.guardState !== "settled"))
          throw new DataFenceBusy();
        return;
      }
      const owned = mirror(saved.receipt.maintenanceId);
      if (canonicalJson(owned.metadata) !== canonicalJson(saved)) throw new DataFenceBusy();
      if (
        grant.ownerCertificateDigest !== owned.ownerCertificateDigest ||
        canonicalJson(grant.owner) !== canonicalJson(saved.receipt.ownerPrepare) ||
        grant.owner.executor !== "ops-agent" ||
        request.input.revisionId !== saved.receipt.revisionId ||
        request.input.planDigest !== saved.receipt.hardlinkPlanDigest ||
        request.input.coordinatorMode !== saved.input.coordinatorMode ||
        grant.serviceIds.some((id) => !saved.input.serviceIds.includes(id))
      )
        throw Object.assign(Error("Generation maintenance owner/revision/hash conflict"), {
          statusCode: 403,
        });
      //01.2 owns the real frozen-step/DB-decision witness and positive
      // continuation. A matching prepared receipt alone authorizes no write.
      throw new DataFenceBusy();
    },
    async withAdmission<T>(run: (tx: Pick<DataFenceSql, "unsafe">) => Promise<T>): Promise<T> {
      return sql.transaction(async (tx) => {
        await lock(tx);
        await assertAdmission(tx);
        return run(tx);
      });
    },
    async prepare(value: DataConfigurationFencePrepare, rawHeaders: readonly string[]) {
      const input = dataConfigurationFencePrepareSchema.parse(value),
        verified = inspectGrant(input, rawHeaders, "configuration-maintenance.prepare");
      const existing = await row(sql, input.maintenanceId);
      if (existing) {
        if (
          canonicalJson(existing.input) !== canonicalJson(input) ||
          existing.receipt.fenceId !== verified.grant.execution.executionId
        )
          throw Object.assign(Error("Configuration fence conflict"), { statusCode: 409 });
        return withLeaf(verified, async () => existing.receipt);
      }
      if (startup === "closed") throw new DataFenceBusy();
      const receipt = dataConfigurationFenceReceiptSchema.parse({
        fenceId: verified.grant.execution.executionId,
        maintenanceId: input.maintenanceId,
        candidateId: input.candidateId,
        ownerPrepare: input.ownerPrepare,
        planDigest: input.planDigest,
        revisionId: input.revisionId,
        hardlinkPlanDigest: input.hardlinkPlanDigest,
        sequence: 0,
        state: "prepared",
      });
      const metadata = metadataSchema.parse({
        version: 1,
        guardState: "preparing",
        receipt,
        input,
      });
      if (!verified.grant.origin) throw Error("Dated configuration guard required");
      const owned = {
        preparedAt: Date.now(),
        version: 1 as const,
        installationId: installation.installationId,
        origin: verified.grant.origin,
        ownerCertificateDigest: verified.grant.ownerCertificateDigest,
        prepareAssertion: verified.assertion,
        metadata,
      };
      return withLeaf(verified, async (authority) => {
        await sql.transaction(async (tx) => {
          await lock(tx);
          await assertAdmission(tx);
          const active = await tx.unsafe(
            "SELECT id FROM data_manager.jobs WHERE kind <> 'configuration-maintenance' AND (finished_at IS NULL OR execution_state->>'publication'='unknown') LIMIT 1",
          );
          const transfers = await tx.unsafe(
            "SELECT id FROM data_manager.offline_package_jobs WHERE status='preparing' LIMIT 1",
          );
          if (active.length || transfers.length) throw new DataFenceBusy();
          write(owned);
          const state = executionAuthorityState(authority),
            terminal = fenceTerminalSchema.parse({
              version: 1,
              phase: "prepared",
              execution: verified.grant.execution,
              admissionDigest: state.receiptDigest,
              terminalDigest: dataFenceTerminalDigest(receipt),
              terminalAt: owned.preparedAt,
            });
          writePrivateRecord(
            local,
            "observations",
            `terminal-${verified.grant.execution.operationKey}.json`,
            signControl(local.privateKey, "openmapx-data-fence-terminal-v1", terminal),
            false,
            state.origin,
          );
          await tx.unsafe(
            "INSERT INTO data_manager.jobs(id,kind,status,started_at,finished_at,operation_key,metadata) VALUES($1::uuid,'configuration-maintenance','ok',$4::text::timestamptz,$4::text::timestamptz,$2,$3::text::jsonb)",
            [
              receipt.fenceId,
              verified.grant.execution.operationKey,
              canonicalJson({ configurationMaintenance: metadata }),
              new Date(owned.preparedAt).toISOString(),
            ],
          );
        });
        metadata.guardState = "prepared";
        write(owned);
        await sql.transaction(async (tx) => {
          await lock(tx);
          const current = await row(tx, input.maintenanceId);
          if (!current || canonicalJson(current.receipt) !== canonicalJson(receipt))
            throw Error("Configuration fence preparation CAS conflict");
          await tx.unsafe(
            "UPDATE data_manager.jobs SET metadata=$2::text::jsonb,ownership_version=ownership_version+1 WHERE id=$1::uuid",
            [receipt.fenceId, canonicalJson({ configurationMaintenance: metadata })],
          );
        });
        startup = "fenced";
        return receipt;
      });
    },
    async inspect(maintenanceId: string, rawHeaders: readonly string[]) {
      const header = rawHeaders.filter(
        (_, index) =>
          index % 2 === 0 &&
          rawHeaders[index]?.toLowerCase() === "x-openmapx-configuration-fence-witness",
      );
      if (header.length !== 1) throw Error("Purpose-bound agent fence witness required");
      const index = rawHeaders.findIndex(
          (name, i) =>
            i % 2 === 0 && name.toLowerCase() === "x-openmapx-configuration-fence-witness",
        ),
        encoded = rawHeaders[index + 1];
      if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded))
        throw Error("Invalid fence witness");
      const witness = verifyControl(
          local.publicKeys["ops-agent"],
          "openmapx-configuration-fence-inspect-v1",
          JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
          inspectWitnessSchema,
        ),
        now = Date.now();
      if (
        witness.installationId !== installation.installationId ||
        witness.maintenanceId !== maintenanceId ||
        witness.issuedAt > now ||
        witness.expiresAt <= now ||
        witness.expiresAt - witness.issuedAt > 15000
      )
        throw Error("Expired or foreign fence witness");
      const saved = await row(sql, maintenanceId);
      if (!saved) return null;
      const proof = mirror(maintenanceId);
      if (
        saved.receipt.candidateId !== witness.candidateId ||
        proof.ownerCertificateDigest !== witness.ownerCertificateDigest ||
        canonicalJson(proof.metadata) !== canonicalJson(saved)
      )
        throw Error("Configuration guard recovery required");
      const anchored = inspectArtifactDelegation({
        dataRoot: local.dataRoot,
        assertion: proof.prepareAssertion,
        installation,
      });
      if (
        anchored.ownerCertificateDigest !== witness.ownerCertificateDigest ||
        controlDigest(anchored.parent) !== controlDigest(saved.receipt.ownerPrepare)
      )
        throw Error("Original owner certificate changed");
      // Verify its still-anchored original owner certificate without granting a mutation.
      const owned = mirrors.get(maintenanceId);
      if (
        !owned ||
        controlDigest(owned.metadata.receipt.ownerPrepare) !==
          controlDigest(saved.receipt.ownerPrepare)
      )
        throw Error("Original fence owner required");
      return saved.receipt;
    },
    async settle(value: DataConfigurationFenceSettle, rawHeaders: readonly string[]) {
      const input = dataConfigurationFenceSettleSchema.parse(value),
        saved = await row(sql, input.maintenanceId);
      if (!saved) throw Object.assign(Error("Unknown configuration fence"), { statusCode: 404 });
      const verified = inspectGrant(
        input,
        rawHeaders,
        "configuration-maintenance.settle",
        saved.input,
      );
      if (
        saved.receipt.candidateId !== input.candidateId ||
        saved.receipt.planDigest !== input.planDigest
      )
        throw Error("Configuration guard settlement identity conflict");
      if (saved.guardState === "settled") {
        if (canonicalJson(saved.settlement) !== canonicalJson(input))
          throw Error("Configuration guard settlement conflict");
        return withLeaf(verified, async () => saved.receipt);
      }
      if (saved.receipt.sequence !== input.expectedSequence)
        throw Error("Configuration guard sequence conflict");
      const receipt = {
          ...saved.receipt,
          state: "settled" as const,
          sequence: saved.receipt.sequence + 1,
        },
        metadata = metadataSchema.parse({ ...saved, guardState: "settling", settlement: input });
      const owned = mirror(input.maintenanceId);
      return withLeaf(verified, async () => {
        await sql.transaction(async (tx) => {
          await lock(tx);
          const current = await row(tx, input.maintenanceId);
          if (canonicalJson(current) !== canonicalJson(saved))
            throw Error("Configuration guard settlement CAS conflict");
          const active = await tx.unsafe(
            "SELECT id FROM data_manager.jobs WHERE kind <> 'configuration-maintenance' AND (finished_at IS NULL OR execution_state->>'publication'='unknown') LIMIT 1",
          );
          if (active.length) throw new DataFenceBusy();
          write({ ...owned, metadata });
          metadata.guardState = "settled";
          metadata.receipt = receipt;
          await tx.unsafe(
            "UPDATE data_manager.jobs SET metadata=$2::text::jsonb,ownership_version=ownership_version+1 WHERE id=$1::uuid",
            [receipt.fenceId, canonicalJson({ configurationMaintenance: metadata })],
          );
        });
        write({ ...owned, metadata });
        startup = "open";
        return receipt;
      });
    },
  };
}

export function dataFenceTerminalDigest(receipt: DataConfigurationFenceReceipt) {
  return controlDigest({ version: 1, receipt: dataConfigurationFenceReceiptSchema.parse(receipt) });
}
/** Fixed SQL-journal retention adapter. Only a fully settled logical guard may
 * retire its original prepared canonical receipt and original terminal time. */
export function verifyRetainedDataFenceTerminal(
  installation: ControlInstallation,
  execution: import("../ops/execution-ref").ExecutionRef,
  raw: Record<string, unknown>,
) {
  const local = installationState(installation),
    metadata = z
      .object({ configurationMaintenance: metadataSchema })
      .parse(raw.metadata).configurationMaintenance;
  const proof = verifyControl(
    installation.publicKey,
    "openmapx-data-configuration-fence-v1",
    readPrivateRecord(
      local,
      "configuration-maintenance",
      `${metadata.receipt.maintenanceId}.json`,
      65536,
    ),
    mirrorSchema,
  );
  if (
    metadata.guardState !== "settled" ||
    canonicalJson(metadata) !== canonicalJson(proof.metadata) ||
    raw.id !== execution.executionId ||
    raw.operation_key !== execution.operationKey ||
    retainedDataDatabaseTimestamp(raw.finished_at).getTime() !== proof.preparedAt
  )
    throw Error("Settled original logical guard required");
  const effect = verifyControl(
    installation.publicKey,
    "openmapx-control-settlement-v1",
    readPrivateRecord(local, "effects", `${execution.operationKey}.json`, 65536),
    z
      .object({
        identity: executionRefSchema,
        receipt: z.object({
          kind: z.literal("data-configuration-fence"),
          receipt: dataConfigurationFenceReceiptSchema,
          guardDigest: z.string(),
        }),
      })
      .passthrough(),
  );
  const original = {
    ...proof,
    metadata: {
      version: 1 as const,
      guardState: "prepared" as const,
      receipt: effect.receipt.receipt,
      input: metadata.input,
    },
  };
  if (
    canonicalJson(effect.identity) !== canonicalJson(execution) ||
    controlDigest(original) !== effect.receipt.guardDigest ||
    effect.receipt.receipt.state !== "prepared" ||
    effect.receipt.receipt.sequence !== 0 ||
    canonicalJson({ ...metadata.receipt, state: "prepared", sequence: 0 }) !==
      canonicalJson(effect.receipt.receipt)
  )
    throw Error("Original logical guard commitment changed");
  const commitment = verifyControl(
      installation.publicKey,
      "openmapx-data-fence-terminal-v1",
      readPrivateRecord(local, "observations", `terminal-${execution.operationKey}.json`, 8192),
      fenceTerminalSchema,
    ),
    authority = executionAuthorityState(restoreAdmittedControlExecution(installation, execution));
  if (
    commitment.phase !== "canonical" ||
    commitment.admissionDigest !== authority.receiptDigest ||
    canonicalJson(commitment.execution) !== canonicalJson(execution) ||
    commitment.terminalDigest !== dataFenceTerminalDigest(effect.receipt.receipt) ||
    commitment.terminalAt !== proof.preparedAt
  )
    throw Error("Original logical guard terminal commitment required");
  verifyControlEffectSettlement(installation, execution);
  return { digest: commitment.terminalDigest, terminalAt: commitment.terminalAt };
}

export function dataFenceRetirementTuple(raw: Record<string, unknown>) {
  const metadata = z
    .object({ configurationMaintenance: metadataSchema })
    .parse(raw.metadata).configurationMaintenance;
  if (metadata.guardState !== "settled") throw Error("Unsettled guard cannot retire");
  return {
    digest: dataFenceTerminalDigest({ ...metadata.receipt, state: "prepared", sequence: 0 }),
    terminalAt: retainedDataDatabaseTimestamp(raw.finished_at).getTime(),
  };
}

export function verifyRetainedDataFenceRefusal(
  installation: ControlInstallation,
  execution: import("../ops/execution-ref").ExecutionRef,
) {
  const local = installationState(installation),
    effect = verifyControl(
      installation.publicKey,
      "openmapx-control-settlement-v1",
      readPrivateRecord(local, "effects", `${execution.operationKey}.json`, 65536),
      z
        .object({
          identity: executionRefSchema,
          outcome: z.literal("failed_without_effect"),
          publication: z.literal("not_started"),
          receipt: z.strictObject({
            kind: z.literal("data-configuration-fence-refused"),
            maintenanceId: z.uuid(),
            reason: z.literal("busy"),
          }),
        })
        .passthrough(),
    ),
    commitment = verifyControl(
      installation.publicKey,
      "openmapx-data-fence-terminal-v1",
      readPrivateRecord(local, "observations", `terminal-${execution.operationKey}.json`, 8192),
      fenceTerminalSchema,
    ),
    authority = executionAuthorityState(restoreAdmittedControlExecution(installation, execution));
  if (
    canonicalJson(effect.identity) !== canonicalJson(execution) ||
    canonicalJson(commitment.execution) !== canonicalJson(execution) ||
    commitment.phase !== "canonical" ||
    commitment.admissionDigest !== authority.receiptDigest ||
    commitment.terminalDigest !== controlDigest({ version: 1, refused: effect.receipt })
  )
    throw Error("Original configuration refusal commitment required");
  verifyControlEffectSettlement(installation, execution);
  return { digest: commitment.terminalDigest, terminalAt: commitment.terminalAt };
}
