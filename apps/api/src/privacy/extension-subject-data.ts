import {
  describeThrown,
  type LoadedIntegration,
  loggableThrown,
  type SubjectDataHandler,
} from "@openmapx/integration-framework";
import { db } from "../db";
import { type IntegrationScope, runInIntegrationScope } from "../integration-scope";
import { processLogger } from "../process-logger";
import { raiseAttention, resolveAttention } from "../services/attention";

/** The longest the host waits for one call of an integration's `erase`. */
export const ERASE_DEADLINE_MS = 30_000;

/** The longest error text kept on a pending erasure. */
const MAX_ERROR_LENGTH = 2_000;

/**
 * The server ends a processing transaction that stays idle this long. The
 * host itself never waits longer than `ERASE_DEADLINE_MS` for a handler; this
 * frees the row lock and the connection even when the API process can no
 * longer run, for example because a handler blocks its event loop.
 */
const ERASE_TRANSACTION_IDLE_LIMIT_MS = ERASE_DEADLINE_MS + 15_000;

interface RegisteredHandler {
  readonly scope: IntegrationScope;
  readonly erase: (subjectId: string) => unknown;
  readonly export: (subjectId: string) => unknown;
}

/**
 * The handler each loaded integration registered, keyed by the generation's
 * record of it: a reload builds new records, so a staged generation never
 * replaces the handler of the one that is serving, and a discarded one
 * leaves nothing behind.
 */
const handlers = new WeakMap<LoadedIntegration, RegisteredHandler>();

/**
 * Records `handler` as `integration`'s subject-data handler, to be called in
 * `scope`. The methods are read once, here, so the handler cannot swap them
 * later. Throws for a second registration and for a handler without both
 * methods.
 */
export function registerSubjectDataHandlerFor(
  integration: LoadedIntegration,
  scope: IntegrationScope,
  handler: SubjectDataHandler,
): void {
  if (handlers.has(integration))
    throw new Error(`Integration ${integration.id} already registered a subject-data handler`);
  const erase = handler?.erase;
  const exportData = handler?.export;
  if (typeof erase !== "function" || typeof exportData !== "function")
    throw new Error(
      `Integration ${integration.id} registered a subject-data handler without export and erase`,
    );
  handlers.set(integration, {
    scope,
    erase: (subjectId) => Reflect.apply(erase, handler, [subjectId]),
    export: (subjectId) => Reflect.apply(exportData, handler, [subjectId]),
  });
}

/** Forgets the handler of an integration whose load is undone. */
export function forgetSubjectDataHandler(integration: LoadedIntegration): void {
  handlers.delete(integration);
}

/** The handler of an integration that is loaded and running, if it registered one. */
function runningHandler(integration: LoadedIntegration): RegisteredHandler | undefined {
  // A disabled integration keeps the load state of its last load but runs no code.
  if (integration.loadState !== "loaded" || !integration.enabled) return undefined;
  return handlers.get(integration);
}

type HandlerCall<T> = { ok: true; value: T } | { ok: false; error: string; timedOut: boolean };

/** Integrations with a handler call still unsettled after its deadline. */
const busyIntegrations = new WeakSet<LoadedIntegration>();

/**
 * Calls one method of a handler in its integration's scope and settles by
 * `deadlineMs` at the latest. It never rejects: whatever the handler throws
 * or rejects with becomes a description. A call still running at the
 * deadline marks the integration busy until it settles.
 */
function callHandler<T>(
  integration: LoadedIntegration,
  registered: RegisteredHandler,
  call: (handler: RegisteredHandler) => unknown,
  deadlineMs: number,
  label: string,
): Promise<HandlerCall<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      busyIntegrations.add(integration);
      resolve({
        ok: false,
        error: `${label} did not finish within ${deadlineMs / 1000} seconds`,
        timedOut: true,
      });
    }, deadlineMs);
    timer.unref?.();
    let pending: Promise<unknown>;
    try {
      // Resolving adopts a thenable, and a `then` that throws becomes a rejection.
      pending = Promise.resolve(runInIntegrationScope(registered.scope, () => call(registered)));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => {
        busyIntegrations.delete(integration);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value: value as T });
      },
      (error: unknown) => {
        busyIntegrations.delete(integration);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error: describeThrown(error), timedOut: false });
      },
    );
  });
}

/** `text` cut to `max` characters without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The outcome of one `erase` call, as the store records it. */
export type ErasureAttempt = { ok: true } | { ok: false; error: string; timedOut: boolean };

/** Where pending erasures and the handler list are kept. */
export interface SubjectErasureStore {
  /**
   * In one transaction: lists `handling`, unlists `stopped` together with
   * their pending erasures, and unlists every integration not in `known`.
   */
  syncHandlers(input: {
    handling: readonly string[];
    stopped: readonly string[];
    known: readonly string[];
  }): Promise<void>;
  /** The subjects whose erasure is pending for an integration, oldest first. */
  pendingSubjects(integrationId: string): Promise<string[]>;
  /**
   * Locks the pending row, runs `erase` and deletes the row on success or
   * counts the attempt. `null` when the row is gone or another run holds it.
   */
  eraseLocked(
    integrationId: string,
    subjectId: string,
    erase: () => Promise<ErasureAttempt>,
  ): Promise<ErasureAttempt | null>;
  count(integrationIds: readonly string[]): Promise<number>;
}

/** The store in the platform database, on the platform's own pool. */
export function createSubjectErasureStore(database: typeof db = db): SubjectErasureStore {
  const client = database.$client;
  return {
    async syncHandlers({ handling, stopped, known }) {
      await client.begin(async (tx) => {
        await tx`insert into integration_subject_handler (integration_id)
          select unnest(${handling as string[]}::text[]) on conflict do nothing`;
        await tx`delete from integration_subject_handler
          where integration_id = any(${stopped as string[]}::text[])
             or integration_id <> all(${known as string[]}::text[])`;
        await tx`delete from subject_erasure_pending
          where integration_id = any(${stopped as string[]}::text[])`;
      });
    },
    async pendingSubjects(integrationId) {
      const rows = await client<Array<{ subject_user_id: string }>>`
        select subject_user_id from subject_erasure_pending
        where integration_id = ${integrationId}
        order by requested_at, subject_user_id`;
      return rows.map((row) => row.subject_user_id);
    },
    async eraseLocked(integrationId, subjectId, erase) {
      return client.begin(async (tx) => {
        await tx`select set_config('idle_in_transaction_session_timeout',
          ${String(ERASE_TRANSACTION_IDLE_LIMIT_MS)}, true)`;
        const locked = await tx`select 1 from subject_erasure_pending
          where integration_id = ${integrationId} and subject_user_id = ${subjectId}
          for update skip locked`;
        if (locked.length === 0) return null;
        const attempt = await erase();
        if (attempt.ok)
          await tx`delete from subject_erasure_pending
            where integration_id = ${integrationId} and subject_user_id = ${subjectId}`;
        else
          await tx`update subject_erasure_pending
            set attempts = attempts + 1, last_error = ${attempt.error}
            where integration_id = ${integrationId} and subject_user_id = ${subjectId}`;
        return attempt;
      }) as Promise<ErasureAttempt | null>;
    },
    async count(integrationIds) {
      if (integrationIds.length === 0) return 0;
      const [row] = await client<Array<{ n: number }>>`
        select count(*)::int as n from subject_erasure_pending
        where integration_id = any(${integrationIds as string[]}::text[])`;
      return row?.n ?? 0;
    },
  };
}

export interface ErasureCounts {
  erased: number;
  failed: number;
}

export interface ExtensionSubjectDataDependencies {
  store: SubjectErasureStore;
  /** The live generation's integrations; `null` before the host has loaded any. */
  integrations: () => readonly LoadedIntegration[] | null;
  attention: {
    raise: (input: Parameters<typeof raiseAttention>[0]) => Promise<unknown>;
    resolve: (key: string) => Promise<unknown>;
  };
  log: { warn(fields: Record<string, unknown>, message: string): void };
  /** `ERASE_DEADLINE_MS` unless a test shortens it. */
  eraseDeadlineMs?: number;
}

export function createExtensionSubjectData(dependencies: ExtensionSubjectDataDependencies) {
  const { store, attention, log } = dependencies;
  const eraseDeadlineMs = dependencies.eraseDeadlineMs ?? ERASE_DEADLINE_MS;

  async function syncSubjectHandlerTable(): Promise<void> {
    const registry = dependencies.integrations();
    if (!registry) return;
    const handling: string[] = [];
    const stopped: string[] = [];
    const known: string[] = [];
    for (const integration of registry) {
      known.push(integration.id);
      // One that cannot run keeps its row, so deletions are still recorded for it.
      if (integration.loadState !== "loaded" || !integration.enabled) continue;
      (handlers.has(integration) ? handling : stopped).push(integration.id);
    }
    await store.syncHandlers({ handling, stopped, known });
  }

  async function updateAttention(
    integration: LoadedIntegration,
    failure: { error: string } | null,
  ): Promise<void> {
    const key = `subject-erasure-pending:${integration.id}`;
    try {
      if (failure) {
        await attention.raise({
          key,
          severity: "warning",
          source: "privacy",
          title: `Erasure pending in ${integration.manifest.name || integration.id}`,
          ...(failure.error ? { detail: failure.error } : {}),
        });
      } else if ((await store.count([integration.id])) === 0) {
        await attention.resolve(key);
      }
    } catch (error) {
      log.warn(
        { err: loggableThrown(error), integrationId: integration.id },
        `Could not update the attention item ${key}`,
      );
    }
  }

  async function eraseFor(
    integration: LoadedIntegration,
    registered: RegisteredHandler,
    counts: ErasureCounts,
  ): Promise<void> {
    let subjects: string[];
    try {
      subjects = await store.pendingSubjects(integration.id);
    } catch (error) {
      log.warn(
        { err: loggableThrown(error), integrationId: integration.id },
        `Could not read the pending erasures of integration ${integration.id}`,
      );
      return;
    }
    let failure: { error: string } | null = null;
    for (const subjectId of subjects) {
      let attempt: ErasureAttempt | null;
      try {
        attempt = await store.eraseLocked(integration.id, subjectId, async () => {
          const call = await callHandler<void>(
            integration,
            registered,
            (handler) => handler.erase(subjectId),
            eraseDeadlineMs,
            "Erase",
          );
          return call.ok
            ? { ok: true }
            : { ok: false, error: truncate(call.error, MAX_ERROR_LENGTH), timedOut: call.timedOut };
        });
      } catch (error) {
        log.warn(
          { err: loggableThrown(error), integrationId: integration.id },
          `Could not record a pending erasure of integration ${integration.id}`,
        );
        return;
      }
      if (!attempt) continue;
      if (attempt.ok) {
        counts.erased += 1;
        continue;
      }
      counts.failed += 1;
      failure = { error: attempt.error };
      // Its handler is still busy; the remaining rows wait for a later run.
      if (attempt.timedOut) break;
    }
    await updateAttention(integration, failure);
  }

  async function processPendingErasures(ids: ReadonlySet<string> | null): Promise<ErasureCounts> {
    const counts: ErasureCounts = { erased: 0, failed: 0 };
    let registry: readonly LoadedIntegration[] | null;
    try {
      registry = dependencies.integrations();
    } catch (error) {
      log.warn({ err: loggableThrown(error) }, "Could not list integrations for pending erasures");
      return counts;
    }
    for (const integration of registry ?? []) {
      if (ids && !ids.has(integration.id)) continue;
      const registered = runningHandler(integration);
      if (!registered || busyIntegrations.has(integration)) continue;
      await eraseFor(integration, registered, counts);
    }
    return counts;
  }

  // One run at a time; callers that arrive while one is going share the next.
  let active: Promise<ErasureCounts> | null = null;
  let queued: { ids: Set<string> | null; promise: Promise<ErasureCounts> } | null = null;

  function begin(ids: ReadonlySet<string> | null): Promise<ErasureCounts> {
    const run = processPendingErasures(ids)
      .catch((error: unknown): ErasureCounts => {
        log.warn({ err: loggableThrown(error) }, "Processing pending erasures failed");
        return { erased: 0, failed: 0 };
      })
      .finally(() => {
        if (active === run) active = null;
      });
    active = run;
    return run;
  }

  /**
   * Works through the pending erasures of every loaded integration with a
   * handler, or of `integrationId` only. Never rejects.
   */
  function runPendingErasures(integrationId?: string): Promise<ErasureCounts> {
    if (!active) return begin(integrationId === undefined ? null : new Set([integrationId]));
    if (queued) {
      if (integrationId === undefined) queued.ids = null;
      else queued.ids?.add(integrationId);
      return queued.promise;
    }
    const current = active;
    const next: { ids: Set<string> | null; promise: Promise<ErasureCounts> } = {
      ids: integrationId === undefined ? null : new Set([integrationId]),
      promise: current.then(() => {
        queued = null;
        return begin(next.ids);
      }),
    };
    queued = next;
    return next.promise;
  }

  async function pendingErasureCount(integrationIds: readonly string[]): Promise<number> {
    return integrationIds.length === 0 ? 0 : store.count(integrationIds);
  }

  return { syncSubjectHandlerTable, runPendingErasures, pendingErasureCount };
}

let integrationSource: (() => readonly LoadedIntegration[]) | null = null;

/** Called by the integration host with its live registry. */
export function setSubjectDataIntegrationSource(
  source: (() => readonly LoadedIntegration[]) | null,
): void {
  integrationSource = source;
}

let platformInstance: ReturnType<typeof createExtensionSubjectData> | null = null;

function platform(): ReturnType<typeof createExtensionSubjectData> {
  platformInstance ??= createExtensionSubjectData({
    store: createSubjectErasureStore(),
    integrations: () => integrationSource?.() ?? null,
    attention: { raise: raiseAttention, resolve: resolveAttention },
    log: processLogger,
  });
  return platformInstance;
}

/**
 * Brings `integration_subject_handler` in line with the live generation:
 * loaded integrations with a handler are listed, loaded ones without are
 * unlisted with their pending erasures, integrations that cannot run keep
 * their row, and integrations no longer installed are unlisted.
 */
export function syncSubjectHandlerTable(): Promise<void> {
  return platform().syncSubjectHandlerTable();
}

/**
 * Calls `erase` for each pending erasure of every loaded integration with a
 * handler, or of `integrationId` only, one at a time, and raises or resolves
 * the integration's attention item after each integration. Never rejects.
 */
export function runPendingErasures(integrationId?: string): Promise<ErasureCounts> {
  return platform().runPendingErasures(integrationId);
}

/** How many erasures are pending for the given integrations. */
export function pendingErasureCount(integrationIds: readonly string[]): Promise<number> {
  return platform().pendingErasureCount(integrationIds);
}
