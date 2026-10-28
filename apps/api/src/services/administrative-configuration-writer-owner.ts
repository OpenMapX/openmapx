import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { getTableColumns, sql as query } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { db, sql } from "../db";
import * as schema from "../db/schema";
import { getAllIntegrations } from "../integration-host";
import { JobOwnershipLost, jobOwnership } from "./admin-job-state";
import type { JobContext } from "./job-runner";
import type { ValidatedConfigurationCandidate } from "./prospective-configuration";
import { getServiceRegistry } from "./service-registry";

const unavailable = () => new Error("Configuration acquisition unavailable");
const rejected = () => new Error("Configuration writer unavailable");

import {
  type AdministrativeConfigurationReadContext,
  closeAdministrativeConfigurationRead,
  openAdministrativeConfigurationRead,
  withAdministrativeConfigurationReadScope,
} from "./administrative-configuration-context";

export {
  type AdministrativeConfigurationReadContext,
  assertAdministrativeConfigurationRead,
} from "./administrative-configuration-context";

const writerBrand: unique symbol = Symbol("administrative configuration writer");
const participantBrand: unique symbol = Symbol("configuration participant");
export type ConfigurationWriteTransaction = Pick<
  typeof db,
  "select" | "insert" | "update" | "delete" | "execute"
>;
export class ConfigurationWriteRolledBack extends Error {
  constructor(readonly failure: unknown) {
    super("Configuration transaction rolled back");
  }
}
export class ConfigurationWriteCommitUnknown extends Error {
  constructor(readonly failure: unknown) {
    super("Configuration transaction outcome unknown");
  }
}
export interface AdministrativeConfigurationWriter {
  readonly [writerBrand]: true;
  readonly actorId: string;
  readonly operationKey: string;
  readonly integrationIds: readonly string[];
}
export interface ConfigurationCommitParticipant {
  readonly [participantBrand]: true;
  readonly kind:
    | "integration-binding"
    | "configuration-migration"
    | "credential-import"
    | "transit-credentials";
  readonly mode: "preview" | "apply";
  readonly actorId: string;
  readonly operationKey: string;
  readonly managedServiceSecretKeys:
    | readonly [{ readonly serviceId: "data-manager"; readonly key: "TRANSITOUS_API_KEYS" }]
    | readonly [];
  authorize(writer: AdministrativeConfigurationWriter): Promise<void>;
  verify(
    candidate: ValidatedConfigurationCandidate,
    writer: AdministrativeConfigurationWriter,
  ): Promise<void>;
  commit(
    candidate: ValidatedConfigurationCandidate,
    writer: AdministrativeConfigurationWriter,
    tx: ConfigurationWriteTransaction,
  ): Promise<void>;
}
interface WriterState {
  active: boolean;
  writer: AdministrativeConfigurationWriter;
  connection: typeof db;
  job: JobContext;
  participant?: ConfigurationCommitParticipant;
  transactionContext?: AdministrativeConfigurationReadContext;
  transactionActive: boolean;
  transactionMode?: "read" | "write";
}
const scope = new AsyncLocalStorage<WriterState>();
const jobs = new AsyncLocalStorage<JobContext>();

export function currentAdministrativeConfigurationWriter(): AdministrativeConfigurationWriter {
  const state = scope.getStore();
  if (!state?.active || state.job.signal.aborted) throw rejected();
  return state.writer;
}
export function administrativeConfigurationState(writer: AdministrativeConfigurationWriter) {
  const state = scope.getStore();
  if (!state?.active || state.writer !== writer || state.job.signal.aborted) throw rejected();
  return state;
}
/** Internal job binding, independent of caller-selected overlay purpose. */
export function withAdministrativeConfigurationJob<T>(
  job: JobContext,
  run: () => Promise<T>,
): Promise<T> {
  const current = jobs.getStore();
  if (current && current !== job) throw rejected();
  if (!job.execution) throw rejected();
  return jobs.run(job, run);
}

async function capture(
  tx: ConfigurationWriteTransaction,
): Promise<AdministrativeConfigurationReadContext> {
  try {
    const immutable = <T>(value: T): T => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) immutable(child);
        Object.freeze(value);
      }
      return value;
    };
    // Registry reload/selection may replace or mutate live metadata while this
    // transaction awaits I/O. Freeze independent JSON observations, not the
    // serving integration's live providers or shutdown handlers.
    const services = Object.freeze(
      getServiceRegistry()
        .list()
        .map((service) =>
          Object.freeze({ ...service, manifest: immutable(structuredClone(service.manifest)) }),
        ),
    );
    const integrations = Object.freeze(
      getAllIntegrations().map((integration) =>
        Object.freeze({
          ...integration,
          manifest: immutable(structuredClone(integration.manifest)),
          config: immutable(structuredClone(integration.config)),
        }),
      ),
    );
    // Sequential reads belong to this transaction, including disabled and orphan rows.
    const serviceRows = await tx
      .select({ ...getTableColumns(schema.serviceConfig), _rowVersion: query<string>`xmin::text` })
      .from(schema.serviceConfig);
    const integrationRows = await tx
      .select({
        ...getTableColumns(schema.integrationConfig),
        _rowVersion: query<string>`xmin::text`,
      })
      .from(schema.integrationConfig);
    const serviceSecretRows = await tx
      .select({ ...getTableColumns(schema.serviceSecret), _rowVersion: query<string>`xmin::text` })
      .from(schema.serviceSecret);
    const integrationSecretRows = await tx
      .select({
        ...getTableColumns(schema.integrationSecret),
        _rowVersion: query<string>`xmin::text`,
      })
      .from(schema.integrationSecret);
    const bindingRows = await tx
      .select({
        ...getTableColumns(schema.capabilityBinding),
        _rowVersion: query<string>`xmin::text`,
      })
      .from(schema.capabilityBinding);
    const bindingRevisionRows = await tx
      .select({
        ...getTableColumns(schema.integrationBindingRevision),
        _rowVersion: query<string>`xmin::text`,
      })
      .from(schema.integrationBindingRevision);
    const context = openAdministrativeConfigurationRead({
      bindingRows,
      bindingRevisionRows,
      services,
      integrations,
      env: Object.freeze({ ...process.env }),
      serviceRows,
      integrationRows,
      serviceSecretRows,
      integrationSecretRows,
    });
    return context;
  } catch {
    throw unavailable();
  }
}
export async function withAdministrativeConfigurationRead<T>(
  options: { signal?: AbortSignal },
  run: (context: AdministrativeConfigurationReadContext) => Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted();
  const state = scope.getStore();
  if (state?.transactionContext)
    return withAdministrativeConfigurationReadScope(state.transactionContext, () =>
      run(state.transactionContext!),
    );
  if (state) {
    if (state.transactionActive) throw unavailable();
    state.transactionActive = true;
    state.transactionMode = "read";
    const connection = state.connection;
    let context: AdministrativeConfigurationReadContext | undefined;
    let started = false;
    try {
      await connection.execute(query`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      started = true;
      context = await capture(connection);
      state.transactionContext = context;
      const result = await withAdministrativeConfigurationReadScope(context, () => run(context!));
      await connection.execute(query`COMMIT`);
      return result;
    } catch (error) {
      if (started) await connection.execute(query`ROLLBACK`);
      throw error;
    } finally {
      state.transactionContext = undefined;
      if (context) closeAdministrativeConfigurationRead(context);
      state.transactionActive = false;
      state.transactionMode = undefined;
    }
  }
  return db.transaction(
    async (tx) => {
      const context = await capture(tx);
      try {
        options.signal?.throwIfAborted();
        return await withAdministrativeConfigurationReadScope(context, () => run(context));
      } finally {
        closeAdministrativeConfigurationRead(context);
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function withConfigurationWriteTransaction<T>(
  writer: AdministrativeConfigurationWriter,
  run: (
    tx: ConfigurationWriteTransaction,
    context: AdministrativeConfigurationReadContext,
  ) => Promise<T>,
): Promise<T> {
  const state = administrativeConfigurationState(writer);
  if (state.transactionActive) throw Error("Configuration transaction already active");
  state.transactionActive = true;
  state.transactionMode = "write";
  const tx = state.connection;
  let started = false,
    commitAttempted = false;
  try {
    await tx.execute(query`BEGIN`);
    started = true;
    const [job] = await tx
      .select()
      .from(schema.adminJob)
      .where(jobOwnership(state.job.jobId, state.job.execution))
      .for("update");
    if (!job) throw new JobOwnershipLost();
    const context = await capture(tx);
    state.transactionContext = context;
    let value: T;
    try {
      value = await withAdministrativeConfigurationReadScope(context, () => run(tx, context));
    } finally {
      state.transactionContext = undefined;
      closeAdministrativeConfigurationRead(context);
    }
    commitAttempted = true;
    await tx.execute(query`COMMIT`);
    return value;
  } catch (error) {
    if (commitAttempted) throw new ConfigurationWriteCommitUnknown(error);
    if (started) {
      try {
        await tx.execute(query`ROLLBACK`);
      } catch (rollback) {
        throw new ConfigurationWriteCommitUnknown(rollback);
      }
      throw new ConfigurationWriteRolledBack(error);
    }
    throw new ConfigurationWriteCommitUnknown(error);
  } finally {
    state.transactionActive = false;
    state.transactionMode = undefined;
  }
}

export async function withAdministrativeConfigurationWriter<T>(
  options: {
    actorId: string;
    operationKey: string;
    integrationIds: readonly string[];
    signal?: AbortSignal;
  },
  run: (writer: AdministrativeConfigurationWriter) => Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted();
  const existing = scope.getStore();
  if (existing) {
    if (
      !existing.active ||
      existing.writer.actorId !== options.actorId ||
      existing.writer.operationKey !== options.operationKey ||
      options.integrationIds.some((id) => !existing.writer.integrationIds.includes(id))
    )
      throw rejected();
    return run(existing.writer);
  }
  const job = jobs.getStore();
  if (!job?.execution || !options.actorId || !options.operationKey) throw rejected();
  const ids = [...new Set(options.integrationIds)].sort();
  if (ids.length > 256 || ids.some((id) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))) throw rejected();
  const reserved = await sql.reserve();
  const locks: number[] = [];
  let global = false;
  try {
    // postgres-js reserves query execution but omits the parent's parser metadata.
    // Drizzle needs that metadata; it must still execute through this reserved SQL.
    const connection = drizzle(Object.assign(reserved, { options: sql.options }), { schema });
    const deadline = Date.now() + 5_000;
    while (!global) {
      options.signal?.throwIfAborted();
      const [row] = await reserved`select pg_try_advisory_lock(${0x4f4d58}, 1) as acquired`;
      global = row?.acquired === true;
      if (!global) {
        if (Date.now() >= deadline) throw rejected();
        await delay(20, undefined, { signal: options.signal });
      }
    }
    // Existing integration namespace; acquire only after the global writer.
    for (const id of ids) {
      const [row] = await reserved`select hashtext(${id}) as key`;
      const key = Number(row?.key);
      while (true) {
        const [lock] = await reserved`select pg_try_advisory_lock(${0x494e54}, ${key}) as acquired`;
        if (lock?.acquired === true) break;
        if (Date.now() >= deadline) throw rejected();
        await delay(20, undefined, { signal: options.signal });
      }
      locks.push(key);
    }
    const unresolved = await connection
      .select({ id: schema.adminJob.id, result: schema.adminJob.result })
      .from(schema.adminJob)
      .where(
        query`${schema.adminJob.result}->'_configurationCandidate' IS NOT NULL AND coalesce(${schema.adminJob.result}->'_configurationCandidate'->>'phase', 'unknown') NOT IN ('settled','discarded')`,
      );
    if (
      unresolved.some(
        (row) =>
          row.id !== job.jobId ||
          (row.result as { _configurationCandidate?: { operationKey?: string } })
            ?._configurationCandidate?.operationKey !== options.operationKey,
      )
    )
      throw rejected();
    const [owned] = await connection
      .select({ id: schema.adminJob.id })
      .from(schema.adminJob)
      .where(jobOwnership(job.jobId, job.execution));
    if (!owned) throw new JobOwnershipLost();
    const writer: AdministrativeConfigurationWriter = Object.freeze({
      [writerBrand]: true as const,
      actorId: options.actorId,
      operationKey: options.operationKey,
      integrationIds: Object.freeze(ids),
    });
    const state: WriterState = { active: true, writer, connection, job, transactionActive: false };
    try {
      return await scope.run(state, () => run(writer));
    } finally {
      state.active = false;
    }
  } finally {
    try {
      for (const key of locks.reverse())
        await reserved`select pg_advisory_unlock(${0x494e54}, ${key})`;
    } finally {
      try {
        if (global) await reserved`select pg_advisory_unlock(${0x4f4d58}, 1)`;
      } finally {
        reserved.release();
      }
    }
  }
}
