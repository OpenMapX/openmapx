import { randomBytes, randomUUID } from "node:crypto";
import { canonicalJson } from "@openmapx/core/ops";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  adminJob,
  capabilityBinding,
  configurationMigrationPreview,
  integrationBindingRevision,
  systemSettings,
} from "../../db/schema";
import { noPendingReceiptDelivery, noUnsettledManagedOperation } from "../admin-job-state";
import type { ConfigurationWriteTransaction } from "../administrative-configuration-writer-owner";
import { decrypt, encrypt } from "../secrets";

export class MigrationConflict extends Error {
  constructor() {
    super("Migration preview is unavailable or changed; create a fresh preview");
  }
}
export type MigrationStage = {
  version: 1;
  actorId: string;
  kind: "migration" | "credentials";
  previewId: string;
  fingerprint: string;
  expiresAt: string;
  value: unknown;
  committed?: {
    jobId: string;
    candidateId: string;
    settingsKeys: string[];
    integrationIds: string[];
    witness: string;
  };
};
const stages = new WeakSet<MigrationStage>();
function immutableStage<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutableStage(child);
    Object.freeze(value);
  }
  return value;
}
export function assertRetainedMigrationStage(stage: MigrationStage) {
  if (!stages.has(stage) || !Object.isFrozen(stage)) throw new MigrationConflict();
}
function sealed(stage: MigrationStage) {
  const text = canonicalJson(stage);
  if (Buffer.byteLength(text) > 1179648) throw new MigrationConflict();
  return encrypt(text);
}
/** Never expires an admitted/unknown owner. Settled ciphertext needs an exact
 * terminal job plus delivered child receipts before removal. */
export async function pruneMigrationStages() {
  return db
    .delete(configurationMigrationPreview)
    .where(
      or(
        and(
          isNull(configurationMigrationPreview.consumedByJobId),
          lt(configurationMigrationPreview.expiresAt, new Date()),
          sql`not exists(select 1 from ${adminJob} where ${adminJob.result}->'_migrationStage'->>'id'=${configurationMigrationPreview.id} and (${adminJob.status} not in ('success','failed','canceled') or (${adminJob.result}->'_configurationCandidate' is not null and coalesce(${adminJob.result}->'_configurationCandidate'->>'phase','unknown') not in ('settled','discarded'))))`,
        ),
        sql`exists(select 1 from ${adminJob} where ${adminJob.id}=${configurationMigrationPreview.consumedByJobId} and ${adminJob.status} in ('success','failed','canceled') and ${adminJob.finishedAt} is not null and ${adminJob.result}->'_configurationCandidate'->>'phase' in ('settled','discarded') and ${noPendingReceiptDelivery()} and ${noUnsettledManagedOperation()})`,
      ),
    )
    .returning({ id: configurationMigrationPreview.id });
}
export async function retainMigrationStage(input: {
  actorId: string;
  kind: MigrationStage["kind"];
  value: unknown;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(71955,1)`);
    await tx
      .delete(configurationMigrationPreview)
      .where(
        and(
          isNull(configurationMigrationPreview.consumedByJobId),
          lt(configurationMigrationPreview.expiresAt, new Date()),
          sql`not exists(select 1 from ${adminJob} where ${adminJob.result}->'_migrationStage'->>'id'=${configurationMigrationPreview.id} and (${adminJob.status} not in ('success','failed','canceled') or (${adminJob.result}->'_configurationCandidate' is not null and coalesce(${adminJob.result}->'_configurationCandidate'->>'phase','unknown') not in ('settled','discarded'))))`,
        ),
      );
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        actor: sql<number>`count(*) filter (where ${configurationMigrationPreview.actorId} = ${input.actorId})::int`,
      })
      .from(configurationMigrationPreview);
    if (!counts || counts.total >= 4096 || counts.actor >= 100) throw new MigrationConflict();
    const stage: MigrationStage = {
      ...input,
      version: 1,
      previewId: randomUUID(),
      fingerprint: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    await tx.insert(configurationMigrationPreview).values({
      id: stage.previewId,
      actorId: stage.actorId,
      kind: stage.kind,
      intentFingerprint: stage.fingerprint,
      ...sealed(stage),
      createdAt: new Date(new Date(stage.expiresAt).getTime() - 600000),
      expiresAt: new Date(stage.expiresAt),
    });
    immutableStage(stage);
    stages.add(stage);
    return stage;
  });
}
export async function readMigrationStage(
  input: { actorId: string; previewId: string; fingerprint: string; kind: MigrationStage["kind"] },
  database: ConfigurationWriteTransaction = db,
) {
  const [row] = await database
    .select()
    .from(configurationMigrationPreview)
    .where(
      and(
        eq(configurationMigrationPreview.id, input.previewId),
        eq(configurationMigrationPreview.actorId, input.actorId),
        eq(configurationMigrationPreview.kind, input.kind),
        eq(configurationMigrationPreview.intentFingerprint, input.fingerprint),
      ),
    );
  if (!row || row.expiresAt <= new Date() || row.consumedByJobId) throw new MigrationConflict();
  try {
    const stage: MigrationStage = JSON.parse(decrypt(row.ciphertext, row.iv, row.tag));
    if (
      stage.version !== 1 ||
      stage.actorId !== row.actorId ||
      stage.kind !== row.kind ||
      stage.previewId !== row.id ||
      stage.fingerprint !== row.intentFingerprint ||
      stage.expiresAt !== row.expiresAt.toISOString()
    )
      throw new MigrationConflict();
    immutableStage(stage);
    stages.add(stage);
    return stage;
  } catch {
    throw new MigrationConflict();
  }
}
export async function replaceMigrationStage(input: {
  actorId: string;
  previewId: string;
  fingerprint: string;
  kind: MigrationStage["kind"];
  value: unknown;
}) {
  return db.transaction(async (tx) => {
    const stage = await readMigrationStage(input, tx),
      fingerprint = randomBytes(32).toString("hex"),
      next = { ...stage, fingerprint, value: input.value };
    const rows = await tx
      .update(configurationMigrationPreview)
      .set({ intentFingerprint: fingerprint, ...sealed(next) })
      .where(
        and(
          eq(configurationMigrationPreview.id, input.previewId),
          eq(configurationMigrationPreview.intentFingerprint, input.fingerprint),
          isNull(configurationMigrationPreview.consumedByJobId),
        ),
      )
      .returning({ id: configurationMigrationPreview.id });
    if (rows.length !== 1) throw new MigrationConflict();
    immutableStage(next);
    stages.add(next);
    return next;
  });
}
export async function consumeMigrationStage(
  stage: MigrationStage,
  jobId: string,
  database: ConfigurationWriteTransaction,
  commit?: { candidateId: string; settingsKeys: string[]; integrationIds: string[] },
) {
  const committed = commit
    ? {
        jobId,
        ...commit,
        witness: await migrationRowWitness(database, commit.settingsKeys, commit.integrationIds),
      }
    : undefined;
  const rows = await database
    .update(configurationMigrationPreview)
    .set({ consumedByJobId: jobId, ...(committed ? sealed({ ...stage, committed }) : {}) })
    .where(
      and(
        eq(configurationMigrationPreview.id, stage.previewId),
        eq(configurationMigrationPreview.actorId, stage.actorId),
        eq(configurationMigrationPreview.intentFingerprint, stage.fingerprint),
        isNull(configurationMigrationPreview.consumedByJobId),
        sql`${configurationMigrationPreview.expiresAt} > now()`,
      ),
    )
    .returning({ id: configurationMigrationPreview.id });
  if (rows.length !== 1) throw new MigrationConflict();
}
async function migrationRowWitness(
  database: ConfigurationWriteTransaction,
  settingsKeys: readonly string[],
  integrationIds: readonly string[],
) {
  const settings = await database
      .select({ key: systemSettings.key, version: sql<string>`xmin::text` })
      .from(systemSettings),
    bindings = await database
      .select({
        integrationId: capabilityBinding.integrationId,
        capability: capabilityBinding.capability,
        version: sql<string>`xmin::text`,
      })
      .from(capabilityBinding),
    revisions = await database
      .select({
        integrationId: integrationBindingRevision.integrationId,
        version: sql<string>`xmin::text`,
      })
      .from(integrationBindingRevision);
  return canonicalJson({
    settings: settings
      .filter((r) => settingsKeys.includes(r.key))
      .sort((a, b) => a.key.localeCompare(b.key)),
    bindings: bindings
      .filter((r) => integrationIds.includes(r.integrationId))
      .sort((a, b) =>
        `${a.integrationId}:${a.capability}`.localeCompare(`${b.integrationId}:${b.capability}`),
      ),
    revisions: revisions
      .filter((r) => integrationIds.includes(r.integrationId))
      .sort((a, b) => a.integrationId.localeCompare(b.integrationId)),
  });
}
/** MAC-retained candidate restart joins the original consumed stage and exact
 * settings/binding xmin receipts. It issues no proof or fresh desired save. */
export async function assertRetainedMigrationRows(
  input: { previewId: string; actorId: string; jobId: string; candidateId: string },
  database: ConfigurationWriteTransaction,
) {
  const [row] = await database
    .select()
    .from(configurationMigrationPreview)
    .where(
      and(
        eq(configurationMigrationPreview.id, input.previewId),
        eq(configurationMigrationPreview.actorId, input.actorId),
        eq(configurationMigrationPreview.consumedByJobId, input.jobId),
      ),
    );
  if (!row) throw new MigrationConflict();
  const stage: MigrationStage = JSON.parse(decrypt(row.ciphertext, row.iv, row.tag)),
    commit = stage.committed;
  if (
    stage.actorId !== input.actorId ||
    stage.previewId !== input.previewId ||
    stage.fingerprint !== row.intentFingerprint ||
    !commit ||
    commit.jobId !== input.jobId ||
    commit.candidateId !== input.candidateId ||
    !Array.isArray(commit.settingsKeys) ||
    commit.settingsKeys.length > 128 ||
    !Array.isArray(commit.integrationIds) ||
    commit.integrationIds.length > 256 ||
    commit.witness !==
      (await migrationRowWitness(database, commit.settingsKeys, commit.integrationIds))
  )
    throw new MigrationConflict();
}
