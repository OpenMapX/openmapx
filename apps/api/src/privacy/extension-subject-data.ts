import {
  describeThrown,
  type LoadedIntegration,
  loggableThrown,
} from "@openmapx/integration-framework";
import { db } from "../db";
import { runInIntegrationScope } from "../integration-scope";
import { processLogger } from "../process-logger";
import { listAttentionKeys, raiseAttention, resolveAttention } from "../services/attention";
import type { CollectorSourcePart } from "./collectors";
import {
  EXTENSION_LOGICAL_ID_PREFIX,
  hasSubjectDataHandler,
  installedIntegrations,
  integrationRuns,
  type RegisteredSubjectDataHandler,
  runningSubjectDataHandler,
  type SubjectDataLog,
} from "./extension-handlers";

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
export const ERASE_TRANSACTION_IDLE_LIMIT_MS = ERASE_DEADLINE_MS + 15_000;

/** The attention item that shows erasures an integration still owes. */
export function erasurePendingAttentionKey(integrationId: string): string {
  return `subject-erasure-pending:${integrationId}`;
}

const ERASURE_ATTENTION_PREFIX = erasurePendingAttentionKey("");

type RegisteredHandler = RegisteredSubjectDataHandler;

type HandlerCall<T> = { ok: true; value: T } | { ok: false; error: string; timedOut: boolean };

/**
 * The calls of one handler method that passed their deadline and have not
 * settled, one per integration record. Erase and export keep separate marks:
 * a hung export must not stop erasures, and an export that settles must not
 * clear the mark of an erase that still hangs. Each mark names its call, so
 * only that call's settling clears it.
 */
type HungCalls = WeakMap<LoadedIntegration, { readonly subjectId: string }>;

const hungErasures: HungCalls = new WeakMap();
const hungExports: HungCalls = new WeakMap();

/**
 * Calls one method of a handler in its integration's scope and settles by
 * `deadlineMs` at the latest. It never rejects: whatever the handler throws
 * or rejects with becomes a description. A call still running at the
 * deadline is marked in `hung` until it settles.
 */
function callHandler<T>(
  integration: LoadedIntegration,
  registered: RegisteredHandler,
  call: (handler: RegisteredHandler) => unknown,
  options: { deadlineMs: number; label: string; hung: HungCalls; subjectId: string },
): Promise<HandlerCall<T>> {
  const { deadlineMs, label, hung } = options;
  const mark = { subjectId: options.subjectId };
  const clearMark = () => {
    if (hung.get(integration) === mark) hung.delete(integration);
  };
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      hung.set(integration, mark);
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
        clearMark();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value: value as T });
      },
      (error: unknown) => {
        clearMark();
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

/**
 * A name an extension gave itself as one line of plain text: control
 * characters and line breaks become spaces, so the name cannot add lines to
 * a plain-text document. Falls back to the id.
 */
export function plainExtensionName(integration: LoadedIntegration | undefined, id: string): string {
  const name = String(integration?.manifest.name ?? "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return name || id;
}

/** `count` deleted accounts, and the verb that goes with them. */
function accountsWaiting(count: number): string {
  return count === 1 ? "1 deleted account waits" : `${count} deleted accounts wait`;
}

/** Why an integration that owes erasures cannot erase now, as a clause. */
function whyNotErasing(integration: LoadedIntegration | undefined): string {
  if (!integration) return "it is not installed, or its installation could not be loaded";
  if (integration.loadState === "failed") return "it failed to load";
  if (integration.loadState === "incompatible")
    return "it is not compatible with this version of OpenMapX";
  if (integration.loadState === "safe-mode") return "the API runs in safe mode";
  if (integration.loadState === "disabled" || !integration.enabled) return "it is disabled";
  return "it registered no subject-data handler";
}

/** The outcome of one `erase` call, as the store records it. */
export type ErasureAttempt = { ok: true } | { ok: false; error: string; timedOut: boolean };

/** Per integration: how many erasures are pending and the most attempts one of them took. */
export type PendingErasureSummary = ReadonlyMap<string, { count: number; attempts: number }>;

/** Where pending erasures and the handler list are kept. */
export interface SubjectErasureStore {
  /**
   * In one transaction: lists `handling` and unlists `stopped` together with
   * their pending erasures. Every other row stays. Answers how many pending
   * erasures it deleted for each integration that had some.
   */
  syncHandlers(input: {
    handling: readonly string[];
    stopped: readonly string[];
  }): Promise<ReadonlyMap<string, number>>;
  /**
   * The subjects whose erasure is pending for an integration: those with the
   * fewest failed attempts first, then the oldest.
   */
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
  /** Counts a failed attempt for an erase whose call has still not settled. */
  recordStalled(integrationId: string, subjectId: string, error: string): Promise<void>;
  pendingSummary(): Promise<PendingErasureSummary>;
  count(integrationIds: readonly string[]): Promise<number>;
}

/** The store in the platform database, on the platform's own pool. */
export function createSubjectErasureStore(
  database: typeof db = db,
  options: { idleLimitMs?: number } = {},
): SubjectErasureStore {
  const client = database.$client;
  const idleLimitMs = options.idleLimitMs ?? ERASE_TRANSACTION_IDLE_LIMIT_MS;
  return {
    async syncHandlers({ handling, stopped }) {
      return client.begin(async (tx) => {
        await tx`insert into integration_subject_handler (integration_id)
          select unnest(${handling as string[]}::text[]) on conflict do nothing`;
        await tx`delete from integration_subject_handler
          where integration_id = any(${stopped as string[]}::text[])`;
        const dropped = await tx<Array<{ integration_id: string; n: number }>>`
          with gone as (
            delete from subject_erasure_pending
            where integration_id = any(${stopped as string[]}::text[])
            returning integration_id)
          select integration_id, count(*)::int as n from gone group by integration_id`;
        return new Map(dropped.map((row) => [row.integration_id, row.n]));
      }) as Promise<ReadonlyMap<string, number>>;
    },
    async pendingSubjects(integrationId) {
      const rows = await client<Array<{ subject_user_id: string }>>`
        select subject_user_id from subject_erasure_pending
        where integration_id = ${integrationId}
        order by attempts, requested_at, subject_user_id`;
      return rows.map((row) => row.subject_user_id);
    },
    async eraseLocked(integrationId, subjectId, erase) {
      return client.begin(async (tx) => {
        await tx`select set_config('idle_in_transaction_session_timeout',
          ${String(idleLimitMs)}, true)`;
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
    async recordStalled(integrationId, subjectId, error) {
      await client`update subject_erasure_pending
        set attempts = attempts + 1, last_error = ${error}
        where integration_id = ${integrationId} and subject_user_id = ${subjectId}`;
    },
    async pendingSummary() {
      const rows = await client<Array<{ integration_id: string; n: number; attempts: number }>>`
        select integration_id, count(*)::int as n, max(attempts)::int as attempts
        from subject_erasure_pending group by integration_id`;
      return new Map(
        rows.map((row) => [row.integration_id, { count: row.n, attempts: row.attempts }]),
      );
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
    /** The keys of the open items that start with `prefix`. */
    openKeys: (prefix: string) => Promise<readonly string[]>;
  };
  log: SubjectDataLog;
  /** `ERASE_DEADLINE_MS` unless a test shortens it. */
  eraseDeadlineMs?: number;
}

export function createExtensionSubjectData(dependencies: ExtensionSubjectDataDependencies) {
  const { store, attention, log } = dependencies;
  const eraseDeadlineMs = dependencies.eraseDeadlineMs ?? ERASE_DEADLINE_MS;

  /** Runs an attention update; a failure is logged and does not stop the caller. */
  async function updateItem(key: string, update: () => Promise<unknown>): Promise<void> {
    try {
      await update();
    } catch (error) {
      log.warn({ err: loggableThrown(error), key }, `Could not update the attention item ${key}`);
    }
  }

  /**
   * Brings `integration_subject_handler` in line with the live generation.
   *
   * An integration's row is deleted only when the integration runs (loaded
   * and enabled) and registered no handler: it erases nothing, so the trigger
   * stops recording deletions for it and the erasures it still owed are
   * dropped. The only other way a row goes is the removal of the
   * integration's data. In every other state (disabled by the operator,
   * failed, incompatible, in safe mode, left out of the registry by the
   * loader, uninstalled with its data kept) the row and the pending erasures
   * stay, so deletions keep being recorded for as long as its data exists.
   * Dropped erasures are logged and their attention item is resolved.
   */
  async function syncSubjectHandlerTable(): Promise<void> {
    const registry = dependencies.integrations();
    if (!registry) return;
    const handling: string[] = [];
    const stopped: string[] = [];
    for (const integration of registry) {
      if (!integrationRuns(integration)) continue;
      (hasSubjectDataHandler(integration) ? handling : stopped).push(integration.id);
    }
    const dropped = await store.syncHandlers({ handling, stopped });
    for (const [integrationId, count] of dropped) {
      if (count === 0) continue;
      log.warn(
        { integrationId, dropped: count },
        `Dropped ${count} owed erasure${count === 1 ? "" : "s"} of integration ${integrationId}: it runs without a subject-data handler, so it no longer erases data`,
      );
      await updateItem(erasurePendingAttentionKey(integrationId), () =>
        attention.resolve(erasurePendingAttentionKey(integrationId)),
      );
    }
  }

  /** Never rejects; a failed sync is logged and the run goes on. */
  async function syncAndRunPendingErasures(): Promise<ErasureCounts> {
    try {
      await syncSubjectHandlerTable();
    } catch (error) {
      log.warn(
        { err: loggableThrown(error) },
        "Could not update the list of integrations with a subject-data handler",
      );
    }
    return runPendingErasures();
  }

  /**
   * Works off one integration's pending erasures. Answers the last error
   * when an erase failed, or `null`.
   */
  async function eraseFor(
    integration: LoadedIntegration,
    registered: RegisteredHandler,
    counts: ErasureCounts,
  ): Promise<string | null> {
    const stalled = hungErasures.get(integration);
    if (stalled) {
      // The call that overran has not settled; calling the handler again
      // would pile up calls. The run counts as one more failed attempt.
      const error = `The erase call that passed its ${eraseDeadlineMs / 1000}-second deadline has still not settled`;
      try {
        await store.recordStalled(integration.id, stalled.subjectId, error);
      } catch (cause) {
        log.warn(
          { err: loggableThrown(cause), integrationId: integration.id },
          `Could not record a pending erasure of integration ${integration.id}`,
        );
      }
      counts.failed += 1;
      return error;
    }
    let subjects: string[];
    try {
      subjects = await store.pendingSubjects(integration.id);
    } catch (error) {
      log.warn(
        { err: loggableThrown(error), integrationId: integration.id },
        `Could not read the pending erasures of integration ${integration.id}`,
      );
      return null;
    }
    let failure: string | null = null;
    for (const subjectId of subjects) {
      let attempt: ErasureAttempt | null;
      try {
        attempt = await store.eraseLocked(integration.id, subjectId, async () => {
          const call = await callHandler<void>(
            integration,
            registered,
            (handler) => handler.erase(subjectId),
            { deadlineMs: eraseDeadlineMs, label: "Erase", hung: hungErasures, subjectId },
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
        return failure;
      }
      if (!attempt) continue;
      if (attempt.ok) {
        counts.erased += 1;
        continue;
      }
      counts.failed += 1;
      failure = attempt.error;
      // Its handler is still busy; the remaining rows wait for a later run.
      if (attempt.timedOut) break;
    }
    return failure;
  }

  /**
   * Raises or resolves each integration's item from what is still pending:
   * a failed erase, or erasures an integration that cannot erase now still
   * owes, raise it; an integration that owes nothing has it resolved.
   */
  async function updateAttention(
    registry: readonly LoadedIntegration[],
    ids: ReadonlySet<string> | null,
    failures: ReadonlyMap<string, string>,
    processed: ReadonlySet<string>,
  ): Promise<void> {
    let summary: PendingErasureSummary;
    let open: readonly string[] = [];
    try {
      summary = await store.pendingSummary();
    } catch (error) {
      log.warn({ err: loggableThrown(error) }, "Could not count the pending erasures");
      return;
    }
    try {
      open = await attention.openKeys(ERASURE_ATTENTION_PREFIX);
    } catch (error) {
      log.warn({ err: loggableThrown(error) }, "Could not read the erasure attention items");
    }
    const byId = new Map(registry.map((integration) => [integration.id, integration]));
    const candidates = new Set([
      ...summary.keys(),
      ...failures.keys(),
      ...processed,
      ...open.map((key) => key.slice(ERASURE_ATTENTION_PREFIX.length)),
    ]);
    for (const integrationId of candidates) {
      if (ids && !ids.has(integrationId)) continue;
      const key = erasurePendingAttentionKey(integrationId);
      const integration = byId.get(integrationId);
      const pending = summary.get(integrationId);
      if (!pending || pending.count === 0) {
        await updateItem(key, () => attention.resolve(key));
        continue;
      }
      const name = plainExtensionName(integration, integrationId);
      const failure = failures.get(integrationId);
      const canErase = integration !== undefined && runningSubjectDataHandler(integration);
      let detail: string | undefined;
      if (failure !== undefined)
        detail = `${accountsWaiting(pending.count)} for this extension to erase its data; erasing has failed up to ${pending.attempts} ${pending.attempts === 1 ? "time" : "times"} per account.${failure ? ` Last error: ${failure}.` : ""} Repair or update the extension, or remove its data.`;
      else if (!canErase)
        detail = `${name} cannot erase data now: ${whyNotErasing(integration)}. ${accountsWaiting(pending.count)} for it to erase their data. Enable or repair the extension, reinstall it, or remove its data.`;
      // An integration that can erase and failed nothing this run keeps its item as it is.
      if (detail === undefined) continue;
      await updateItem(key, () =>
        attention.raise({
          key,
          severity: "warning",
          source: "privacy",
          title: `Erasure pending in ${name}`,
          detail,
        }),
      );
    }
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
    const failures = new Map<string, string>();
    const processed = new Set<string>();
    for (const integration of registry ?? []) {
      if (ids && !ids.has(integration.id)) continue;
      const registered = runningSubjectDataHandler(integration);
      if (!registered) continue;
      processed.add(integration.id);
      const failure = await eraseFor(integration, registered, counts);
      if (failure !== null) failures.set(integration.id, failure);
    }
    // Before the host has loaded anything, nobody can tell who could erase.
    if (registry) await updateAttention(registry, ids, failures, processed);
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
   * handler, or of `integrationId` only, then brings the attention items in
   * line. Never rejects.
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

  return {
    syncSubjectHandlerTable,
    syncAndRunPendingErasures,
    runPendingErasures,
    pendingErasureCount,
  };
}

let platformInstance: ReturnType<typeof createExtensionSubjectData> | null = null;

function platform(): ReturnType<typeof createExtensionSubjectData> {
  platformInstance ??= createExtensionSubjectData({
    store: createSubjectErasureStore(),
    integrations: installedIntegrations,
    attention: { raise: raiseAttention, resolve: resolveAttention, openKeys: listAttentionKeys },
    log: processLogger,
  });
  return platformInstance;
}

/**
 * Brings `integration_subject_handler` in line with the live generation: an
 * integration that runs with a handler is listed, one that runs without one
 * is unlisted together with the erasures it owed, and every other row stays.
 */
export function syncSubjectHandlerTable(): Promise<void> {
  return platform().syncSubjectHandlerTable();
}

/**
 * Calls `erase` for each pending erasure of every loaded integration with a
 * handler, or of `integrationId` only, one at a time, then raises or resolves
 * each integration's attention item. Never rejects.
 */
export function runPendingErasures(integrationId?: string): Promise<ErasureCounts> {
  return platform().runPendingErasures(integrationId);
}

/**
 * The daily run: syncs the handler table, so a sync that failed at an
 * activation is made up for, then works through the pending erasures.
 * Never rejects.
 */
export function syncAndRunPendingErasures(): Promise<ErasureCounts> {
  return platform().syncAndRunPendingErasures();
}

/** The longest the host waits for one call of an integration's `export`. */
export const EXPORT_DEADLINE_MS = 30_000;

/** The most an extension's export may take up in the archive, as JSON. */
export const MAX_EXTENSION_EXPORT_BYTES = 8 * 1024 * 1024;

class ExportTooLarge extends Error {}

/**
 * The JSON text of what an export returned, or `null` when it is larger than
 * `MAX_EXTENSION_EXPORT_BYTES`. A large value is abandoned while it is being
 * written, before all of it is in memory. Throws when the value cannot be
 * written as JSON: a cycle, a BigInt, a `toJSON` that throws, or a top-level
 * value JSON has no text for, such as a function. `undefined` is written as
 * `null`.
 */
function serialiseExport(value: unknown): string | null {
  let remaining = MAX_EXTENSION_EXPORT_BYTES;
  const tooLarge = new ExportTooLarge();
  let json: string | undefined;
  try {
    // A character takes at least one byte, so counting characters never
    // stops a value that would fit.
    json = JSON.stringify(value === undefined ? null : value, (key, item: unknown) => {
      remaining -= key.length + (typeof item === "string" ? item.length : 1);
      if (remaining < 0) throw tooLarge;
      return item;
    });
  } catch (error) {
    if (error === tooLarge) return null;
    throw error;
  }
  if (json === undefined) throw new Error("The export is not a JSON value");
  return Buffer.byteLength(json, "utf8") > MAX_EXTENSION_EXPORT_BYTES ? null : json;
}

type ExtensionWarningCode =
  | "extension-not-loaded"
  | "extension-handler-failed"
  | "extension-export-too-large";

/**
 * One part per integration that registered a handler and per integration
 * that is listed in `integration_subject_handler` but cannot run. Every
 * handler is asked at once, each with `exportDeadlineMs`. Nothing an
 * extension returns or throws fails the collection: what cannot be included
 * becomes an unavailable part that does not block the export, and the reason
 * is logged for the administrator. Without a registry (outside the API),
 * every listed integration is reported as not loaded.
 */
export async function collectExtensionParts(input: {
  userId: string;
  integrations: readonly LoadedIntegration[] | null;
  listed: () => Promise<readonly string[]>;
  log: SubjectDataLog;
  exportDeadlineMs?: number;
}): Promise<CollectorSourcePart[]> {
  const { userId, log } = input;
  const listed = new Set(await input.listed());
  const capturedAt = new Date().toISOString();
  const part = (
    integrationId: string,
    name: string,
    outcome: { code: ExtensionWarningCode } | { source: Buffer },
  ): CollectorSourcePart => ({
    registrationId: `${EXTENSION_LOGICAL_ID_PREFIX}${integrationId}`,
    category: "extension",
    records: [],
    recordCount: "source" in outcome ? 1 : 0,
    outcome: "source" in outcome ? "included" : "unavailable",
    warningCodes: "code" in outcome ? [outcome.code] : [],
    capturedAt,
    blocking: false,
    extension: { integrationId, name },
    ...("source" in outcome
      ? {
          entries: [
            {
              logicalId: `${EXTENSION_LOGICAL_ID_PREFIX}${integrationId}`,
              source: outcome.source,
              mediaType: "application/json",
            },
          ],
        }
      : {}),
  });
  if (!input.integrations)
    return [...listed]
      .sort()
      .map((integrationId) => part(integrationId, integrationId, { code: "extension-not-loaded" }));

  const asked = input.integrations.map(async (integration) => {
    const { id } = integration;
    const name = integration.manifest.name || id;
    const registered = runningSubjectDataHandler(integration);
    if (!registered)
      return !integrationRuns(integration) && listed.has(id)
        ? part(id, name, { code: "extension-not-loaded" })
        : null;
    const failed = (code: ExtensionWarningCode, error: string, message: string) => {
      log.warn({ integrationId: id, error }, message);
      return part(id, name, { code });
    };
    // A call that is still running would only pile up behind the hung one.
    if (hungExports.has(integration))
      return failed(
        "extension-handler-failed",
        "an earlier export call has not settled",
        `The subject-data export of integration ${id} failed`,
      );
    const call = await callHandler<unknown>(
      integration,
      registered,
      (handler) => handler.export(userId),
      {
        deadlineMs: input.exportDeadlineMs ?? EXPORT_DEADLINE_MS,
        label: "Export",
        hung: hungExports,
        subjectId: userId,
      },
    );
    if (!call.ok)
      return failed(
        "extension-handler-failed",
        call.error,
        `The subject-data export of integration ${id} failed`,
      );
    let json: string | null;
    try {
      // `toJSON` and getters are the integration's code too.
      json = runInIntegrationScope(registered.scope, () => serialiseExport(call.value));
    } catch (error) {
      return failed(
        "extension-handler-failed",
        describeThrown(error),
        `The subject-data export of integration ${id} cannot be written as JSON`,
      );
    }
    if (json === null)
      return failed(
        "extension-export-too-large",
        `larger than ${MAX_EXTENSION_EXPORT_BYTES} bytes`,
        `The subject-data export of integration ${id} is too large to include`,
      );
    return part(id, name, { source: Buffer.from(json, "utf8") });
  });
  return (await Promise.all(asked)).filter((candidate) => candidate !== null);
}

/**
 * The extension parts of a person's export, from the live registry and the
 * handler table in `database` (the platform's, unless the manual backup
 * export reads a restored copy).
 */
export function collectExtensionSubjectData(args: {
  userId: string;
  database?: typeof db;
}): Promise<CollectorSourcePart[]> {
  const client = (args.database ?? db).$client;
  return collectExtensionParts({
    userId: args.userId,
    integrations: installedIntegrations(),
    listed: async () => {
      const rows = await client<Array<{ integration_id: string }>>`
        select integration_id from integration_subject_handler order by integration_id`;
      return rows.map((row) => row.integration_id);
    },
    log: processLogger,
  });
}

/** How many erasures are pending for the given integrations. */
export function pendingErasureCount(integrationIds: readonly string[]): Promise<number> {
  return platform().pendingErasureCount(integrationIds);
}
