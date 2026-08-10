/**
 * Orchestrates the OSM contribution boundary.
 *
 * The safety-relevant sequencing lives here: every mutation re-checks the
 * feature flags and the live account state, validates and version-checks
 * *before* a changeset exists, sends exactly one element update, and closes the
 * changeset in `finally` once its id is known. A lost response is never retried
 * blindly — it is reconciled against the live element and the known changeset.
 */
import type {
  OsmCategorySearchQuery,
  OsmCategorySuggestion,
  OsmContributionCapabilities,
  OsmContributionContext,
  OsmContributionLocale,
  OsmContributionPreview,
  OsmContributionPreviewRequest,
  OsmContributionPublishRequest,
  OsmContributionPublishResult,
  OsmElementRef,
  OsmEvidence,
  OsmGeometry,
  OsmNoteRequest,
  OsmNoteResult,
} from "@openmapx/core";
import { inferEditableWayGeometry, suggestEditablePresets } from "@openmapx/presets";
import type { OsmConfig } from "../../utils/osm-config.js";
import type { OsmAccountService, OsmAccountState } from "./account.js";
import { deriveCapabilities } from "./account.js";
import type { StoredOutcome, SubmissionGuard } from "./submission-guard.js";
import { applyOsmFieldChanges, buildContextFields } from "./tag-policy.js";
import {
  isOsmContributionError,
  isOsmUpstreamError,
  type OsmApiClient,
  OsmContributionError,
  type OsmElement,
  type OsmOperation,
  type OsmWritableElement,
} from "./types.js";

/** Closed outcome enum shared with metrics; no free-form label ever appears. */
export type OsmOperationOutcome =
  | "success"
  | "disabled"
  | "invalid"
  | "unauthorized"
  | "blocked"
  | "conflict"
  | "rate_limited"
  | "not_found"
  | "upstream_error"
  | "ambiguous";

export interface OsmContributionLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface OsmRequestContext {
  headers: Headers;
  userId: string;
  requestId: string;
}

export interface OsmContributionServiceDeps {
  config: OsmConfig;
  account: OsmAccountService;
  client: OsmApiClient;
  guard: SubmissionGuard;
  now?: () => Date;
  logger?: OsmContributionLogger;
  recordOperation?: (
    operation: OsmOperation,
    outcome: OsmOperationOutcome,
    durationMs: number,
  ) => void;
}

export interface OsmContributionService {
  getCapabilities(ctx: OsmRequestContext): Promise<OsmContributionCapabilities>;
  getContext(
    ctx: OsmRequestContext,
    ref: OsmElementRef,
    locale: OsmContributionLocale,
  ): Promise<OsmContributionContext>;
  suggestCategories(
    ctx: OsmRequestContext,
    query: OsmCategorySearchQuery,
  ): Promise<OsmCategorySuggestion[]>;
  preview(
    ctx: OsmRequestContext,
    request: OsmContributionPreviewRequest,
  ): Promise<OsmContributionPreview>;
  publish(
    ctx: OsmRequestContext,
    request: OsmContributionPublishRequest,
  ): Promise<OsmContributionPublishResult>;
  createNote(ctx: OsmRequestContext, request: OsmNoteRequest): Promise<OsmNoteResult>;
}

/** Public `source` values. `signage` is an in-person observation, i.e. a survey. */
function mapEvidence(evidence: OsmEvidence): string {
  switch (evidence.kind) {
    case "survey":
    case "signage":
      return "survey";
    case "officialWebsite":
      return "official website";
    default:
      return evidence.detail;
  }
}

function outcomeForCode(code: OsmContributionError["code"]): OsmOperationOutcome {
  switch (code) {
    case "FEATURE_DISABLED":
    case "DIRECT_EDITING_DISABLED":
      return "disabled";
    case "OSM_ACCOUNT_NOT_LINKED":
    case "OSM_REAUTHORIZATION_REQUIRED":
    case "CONTRIBUTOR_TERMS_REQUIRED":
      return "unauthorized";
    case "OSM_ACCOUNT_BLOCKED":
      return "blocked";
    case "ELEMENT_NOT_FOUND":
    case "ELEMENT_DELETED":
      return "not_found";
    case "VERSION_CONFLICT":
    case "SUBMISSION_IN_PROGRESS":
      return "conflict";
    case "RATE_LIMITED":
      return "rate_limited";
    case "AMBIGUOUS_RESULT":
      return "ambiguous";
    case "OSM_UNAVAILABLE":
    case "UPSTREAM_INVALID":
      return "upstream_error";
    default:
      return "invalid";
  }
}

/** Translate an upstream failure into a public code, discarding its detail. */
function mapUpstream(error: unknown, operation: OsmOperation): OsmContributionError {
  if (isOsmContributionError(error)) return error;
  if (!isOsmUpstreamError(error)) {
    return new OsmContributionError("OSM_UNAVAILABLE", 502, "OpenStreetMap is unavailable.");
  }
  switch (error.status) {
    case 401:
    case 403:
      return new OsmContributionError(
        "OSM_REAUTHORIZATION_REQUIRED",
        403,
        "Your OpenStreetMap authorization is no longer sufficient.",
      );
    case 404:
      return new OsmContributionError(
        "ELEMENT_NOT_FOUND",
        404,
        "That OpenStreetMap element no longer exists.",
      );
    case 410:
      return new OsmContributionError(
        "ELEMENT_DELETED",
        410,
        "That OpenStreetMap element has been deleted.",
      );
    case 409:
    case 412:
      return new OsmContributionError(
        "VERSION_CONFLICT",
        409,
        "The element changed in OpenStreetMap while you were editing.",
      );
    case 429:
      return new OsmContributionError(
        "RATE_LIMITED",
        429,
        "OpenStreetMap is throttling requests.",
        {
          ...(error.retryAfterSeconds === null
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        },
      );
    case 400:
    case 422:
      return new OsmContributionError(
        "UPSTREAM_INVALID",
        502,
        "OpenStreetMap rejected the change.",
      );
    default:
      return error.status === null && operation !== "publish"
        ? new OsmContributionError(
            "UPSTREAM_INVALID",
            502,
            "OpenStreetMap sent an unusable response.",
          )
        : new OsmContributionError("OSM_UNAVAILABLE", 502, "OpenStreetMap is unavailable.");
  }
}

function isNodeCentre(element: OsmElement): { lat: number; lon: number } | null {
  return element.type === "node" ? { lat: element.lat, lon: element.lon } : null;
}

function boundsCentre(
  nodes: ReadonlyArray<{ lat: number; lon: number }>,
): { lat: number; lon: number } | null {
  if (nodes.length === 0) return null;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minLat = Math.min(minLat, node.lat);
    maxLat = Math.max(maxLat, node.lat);
    minLon = Math.min(minLon, node.lon);
    maxLon = Math.max(maxLon, node.lon);
  }
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

function tagsEqual(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

export function createOsmContributionService(
  deps: OsmContributionServiceDeps,
): OsmContributionService {
  const { config, account, client, guard } = deps;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger;

  function record(
    operation: OsmOperation,
    outcome: OsmOperationOutcome,
    startedAt: number,
    ctx: OsmRequestContext,
  ): void {
    const durationMs = Date.now() - startedAt;
    deps.recordOperation?.(operation, outcome, durationMs);
    // Deliberately content-free: operation, outcome, duration and a request id.
    logger?.info({ operation, outcome, durationMs, requestId: ctx.requestId }, "osm contribution");
  }

  async function observe<T>(
    operation: OsmOperation,
    ctx: OsmRequestContext,
    run: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      record(operation, "success", startedAt, ctx);
      return result;
    } catch (error) {
      const mapped = isOsmContributionError(error) ? error : mapUpstream(error, operation);
      record(operation, outcomeForCode(mapped.code), startedAt, ctx);
      throw mapped;
    }
  }

  function requireFeature(): void {
    if (!config.contributionsEnabled || !config.oauthConfigured) {
      throw new OsmContributionError(
        "FEATURE_DISABLED",
        403,
        "Contributing to OpenStreetMap is not enabled on this instance.",
      );
    }
  }

  function requireDirectEditing(): void {
    requireFeature();
    if (!config.directEditingEnabled) {
      throw new OsmContributionError(
        "DIRECT_EDITING_DISABLED",
        403,
        "Direct OpenStreetMap editing is currently switched off.",
      );
    }
  }

  /** Re-checked immediately before every mutation, never cached by the UI. */
  function requireWritable(
    state: OsmAccountState,
    scope: "write_api" | "write_notes",
  ): Extract<OsmAccountState, { status: "linked" }> {
    if (state.status === "not_linked") {
      throw new OsmContributionError(
        "OSM_ACCOUNT_NOT_LINKED",
        403,
        "Link an OpenStreetMap account first.",
      );
    }
    if (state.status === "reauthorization_required") {
      throw new OsmContributionError(
        "OSM_REAUTHORIZATION_REQUIRED",
        403,
        "Authorize OpenMapX with OpenStreetMap again.",
      );
    }
    const granted =
      scope === "write_api" ? state.permissions.allowWriteApi : state.permissions.allowWriteNotes;
    if (!granted) {
      throw new OsmContributionError(
        "OSM_REAUTHORIZATION_REQUIRED",
        403,
        "Grant OpenMapX the permission this action needs.",
      );
    }
    if (!state.user.contributorTermsAgreed) {
      throw new OsmContributionError(
        "CONTRIBUTOR_TERMS_REQUIRED",
        403,
        "Accept the OpenStreetMap Contributor Terms first.",
      );
    }
    if (state.user.activeBlock) {
      throw new OsmContributionError(
        "OSM_ACCOUNT_BLOCKED",
        403,
        "Your OpenStreetMap account has an active block.",
      );
    }
    return state;
  }

  async function readElement(ref: OsmElementRef, operation: OsmOperation): Promise<OsmElement> {
    try {
      return await client.getElement(ref);
    } catch (error) {
      throw mapUpstream(error, operation);
    }
  }

  /**
   * Conservative geometry. A closed way is never assumed to be an area: only
   * explicit `area` tagging or an unambiguous preset match decides.
   */
  async function resolveGeometryAndCentre(
    element: OsmElement,
  ): Promise<{ geometry: OsmGeometry; center: { lat: number; lon: number } | null }> {
    if (element.type === "node") {
      return { geometry: "point", center: isNodeCentre(element) };
    }
    let nodes: Array<{ lat: number; lon: number }> = [];
    try {
      const full = await client.getFullElement({ type: element.type, id: element.id });
      nodes = full.nodes;
    } catch {
      // A missing centre only disables Note creation; it is not a hard failure.
      nodes = [];
    }
    const center = boundsCentre(nodes);
    if (element.type === "relation") return { geometry: "relation", center };
    const closed =
      element.nodes.length > 2 && element.nodes[0] === element.nodes[element.nodes.length - 1];
    return { geometry: inferEditableWayGeometry(element.tags, closed), center };
  }

  async function buildContext(
    element: OsmElement,
    locale: OsmContributionLocale,
  ): Promise<OsmContributionContext> {
    const { geometry, center } = await resolveGeometryAndCentre(element);
    const ref: OsmElementRef = { type: element.type, id: element.id };
    return {
      ref,
      version: element.version,
      geometry,
      ...(element.changeset === undefined ? {} : { changesetId: element.changeset }),
      center,
      displayName: element.tags.name ?? null,
      currentPreset: currentPresetStatus(element.tags, geometry, locale),
      fields: buildContextFields(element.tags, geometry, locale),
      advancedEditorUrl: config.advancedEditorUrl(ref, center ?? undefined),
      elementUrl: config.elementUrl(ref),
      fetchedAt: now().toISOString(),
    };
  }

  function currentPresetStatus(
    tags: Readonly<Record<string, string>>,
    geometry: OsmGeometry,
    locale: OsmContributionLocale,
  ): OsmContributionContext["currentPreset"] {
    if (geometry === "unknown") return { status: "unsupported", reason: "GEOMETRY" };
    const fields = buildContextFields(tags, geometry, locale);
    const category = fields.find((field) => field.field === "category");
    if (category?.kind === "category" && category.enabled && category.currentPresetId) {
      return {
        status: "matched",
        presetId: category.currentPresetId,
        name: category.currentPresetName ?? category.currentPresetId,
      };
    }
    if (category?.disabledReason === "CATEGORY_AMBIGUOUS") return { status: "ambiguous" };
    if (category?.disabledReason === "LIFECYCLE_STATE") {
      return { status: "unsupported", reason: "LIFECYCLE" };
    }
    return { status: "unsupported", reason: "NO_MATCH" };
  }

  async function freshConflict(locale: OsmContributionLocale, element: OsmElement): Promise<never> {
    throw new OsmContributionError(
      "VERSION_CONFLICT",
      409,
      "The element changed in OpenStreetMap while you were editing.",
      { context: await buildContext(element, locale) },
    );
  }

  /**
   * Close a changeset whose id is known. Closing is the only safely repeatable
   * mutation here, and only when the changeset is *confirmed* still open.
   */
  async function closeChangeset(changesetId: number, token: string): Promise<void> {
    try {
      await client.closeChangeset(changesetId, token);
      return;
    } catch (error) {
      if (!isOsmUpstreamError(error) || !error.requestMayHaveBeenApplied) {
        logger?.warn(
          { operation: "close_changeset", outcome: "upstream_error" },
          "osm contribution",
        );
        return;
      }
      try {
        const changeset = await client.getChangeset(changesetId);
        if (!changeset.open) return;
        await client.closeChangeset(changesetId, token);
      } catch {
        // Unconfirmed closure is an operational signal only; OSM expires an
        // abandoned changeset on its own and the element update already stands.
        logger?.warn({ operation: "close_changeset", outcome: "ambiguous" }, "osm contribution");
      }
    }
  }

  async function reconcileLostUpdate(
    request: OsmContributionPublishRequest,
    expected: OsmWritableElement,
    base: OsmElement,
    changesetId: number,
  ): Promise<OsmContributionPublishResult> {
    const current = await readElement(request.ref, "reconcile").catch(() => null);
    if (current) {
      if (
        current.version === base.version + 1 &&
        current.changeset === changesetId &&
        tagsEqual(current.tags, expected.tags)
      ) {
        return {
          ref: request.ref,
          version: current.version,
          changesetId,
          changesetUrl: config.changesetUrl(changesetId),
          elementUrl: config.elementUrl(request.ref),
          publishedAt: now().toISOString(),
        };
      }
      if (current.version === base.version && tagsEqual(current.tags, base.tags)) {
        throw new OsmContributionError(
          "OSM_UNAVAILABLE",
          502,
          "OpenStreetMap did not apply the change. You can try again.",
        );
      }
    }
    throw new OsmContributionError(
      "AMBIGUOUS_RESULT",
      502,
      "OpenMapX could not confirm whether the change was applied. Check the links before trying again.",
      {
        inspect: {
          changesetUrl: config.changesetUrl(changesetId),
          elementUrl: config.elementUrl(request.ref),
        },
      },
    );
  }

  async function withGuard<T>(
    ctx: OsmRequestContext,
    identity: { ref: OsmElementRef; operation: "publish" | "note"; idempotencyKey: string },
    replay: (outcome: StoredOutcome) => T,
    run: (finish: (outcome: StoredOutcome) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const key = { userId: ctx.userId, ...identity };
    const begun = await guard.begin(key);
    if (begun.status === "replay") return replay(begun.outcome);
    if (begun.status === "in_progress") {
      throw new OsmContributionError(
        "SUBMISSION_IN_PROGRESS",
        409,
        "This contribution is already being submitted.",
      );
    }
    try {
      return await run(async (outcome) => {
        await guard.storeOutcome({ ...key, outcome });
      });
    } finally {
      await guard.release({ ...key, lease: begun.lease });
    }
  }

  function replayPublish(outcome: StoredOutcome): OsmContributionPublishResult {
    if (outcome.kind === "success") return outcome.result as OsmContributionPublishResult;
    throw new OsmContributionError(
      "AMBIGUOUS_RESULT",
      502,
      "OpenMapX could not confirm whether the change was applied. Check the links before trying again.",
      outcome.inspect ? { inspect: outcome.inspect } : {},
    );
  }

  return {
    async getCapabilities(ctx) {
      return observe("capabilities", ctx, async () => {
        if (!config.contributionsEnabled || !config.oauthConfigured) {
          return deriveCapabilities({ config, state: { status: "not_linked" } });
        }
        return deriveCapabilities({ config, state: await account.load(ctx.headers) });
      });
    },

    async getContext(ctx, ref, locale) {
      return observe("context", ctx, async () => {
        requireFeature();
        return buildContext(await readElement(ref, "context"), locale);
      });
    },

    async suggestCategories(ctx, query) {
      return observe("categories", ctx, async () => {
        requireFeature();
        return suggestEditablePresets({
          query: query.q,
          geometry: query.geometry,
          lang: query.locale,
          limit: query.limit,
        }).map((preset) => ({
          presetId: preset.presetId,
          name: preset.name,
          ...(preset.iconKey ? { iconKey: preset.iconKey } : {}),
          geometry: [...preset.geometry],
        }));
      });
    },

    async preview(ctx, request) {
      return observe("preview", ctx, async () => {
        requireFeature();
        requireWritable(await account.load(ctx.headers), "write_api");
        const element = await readElement(request.ref, "preview");
        if (element.version !== request.baseVersion) {
          await freshConflict(request.locale, element);
        }
        const { geometry } = await resolveGeometryAndCentre(element);
        return applyOsmFieldChanges({
          baseElement: element,
          geometry,
          changes: request.changes,
          locale: request.locale,
        }).preview;
      });
    },

    async publish(ctx, request) {
      return observe("publish", ctx, async () =>
        withGuard(
          ctx,
          { ref: request.ref, operation: "publish", idempotencyKey: request.idempotencyKey },
          replayPublish,
          async (finish) => {
            requireDirectEditing();
            const state = requireWritable(await account.load(ctx.headers), "write_api");

            const base = await readElement(request.ref, "publish");
            if (base.version !== request.baseVersion) {
              await freshConflict(request.locale, base);
            }

            const { geometry } = await resolveGeometryAndCentre(base);
            // Everything above must succeed before a changeset can exist.
            const prepared = applyOsmFieldChanges({
              baseElement: base,
              geometry,
              changes: request.changes,
              locale: request.locale,
            });

            let changesetId: number;
            try {
              changesetId = await client.createChangeset(
                {
                  comment: request.comment,
                  created_by: `OpenMapX ${config.appVersion}`,
                  locale: request.locale,
                  source: mapEvidence(request.evidence),
                  ...(request.reviewRequested ? { review_requested: "yes" } : {}),
                },
                state.accessToken,
              );
            } catch (error) {
              if (isOsmUpstreamError(error) && error.requestMayHaveBeenApplied) {
                // The create may have reached OSM but returned no id: there is
                // nothing to address, so no update, no close and no retry.
                const outcome: StoredOutcome = {
                  kind: "terminal",
                  at: now().toISOString(),
                  code: "AMBIGUOUS_RESULT",
                };
                await finish(outcome);
                throw new OsmContributionError(
                  "AMBIGUOUS_RESULT",
                  502,
                  "OpenMapX could not confirm whether a changeset was opened. Nothing was published.",
                );
              }
              throw mapUpstream(error, "publish");
            }

            const element: OsmWritableElement = { ...prepared.element, changeset: changesetId };
            try {
              let result: OsmContributionPublishResult;
              try {
                const version = await client.updateElement(element, state.accessToken);
                result = {
                  ref: request.ref,
                  version,
                  changesetId,
                  changesetUrl: config.changesetUrl(changesetId),
                  elementUrl: config.elementUrl(request.ref),
                  publishedAt: now().toISOString(),
                };
              } catch (error) {
                if (isOsmUpstreamError(error) && error.requestMayHaveBeenApplied) {
                  result = await reconcileLostUpdate(request, element, base, changesetId);
                } else {
                  throw mapUpstream(error, "publish");
                }
              }
              await finish({ kind: "success", at: now().toISOString(), result });
              return result;
            } catch (error) {
              if (isOsmContributionError(error) && error.code === "AMBIGUOUS_RESULT") {
                await finish({
                  kind: "terminal",
                  at: now().toISOString(),
                  code: "AMBIGUOUS_RESULT",
                  ...(error.inspect ? { inspect: error.inspect } : {}),
                });
              }
              throw error;
            } finally {
              await closeChangeset(changesetId, state.accessToken);
            }
          },
        ),
      );
    },

    async createNote(ctx, request) {
      return observe("note", ctx, async () =>
        withGuard(
          ctx,
          { ref: request.ref, operation: "note", idempotencyKey: request.idempotencyKey },
          (outcome) => {
            if (outcome.kind === "success") return outcome.result as OsmNoteResult;
            throw new OsmContributionError(
              "AMBIGUOUS_RESULT",
              502,
              "OpenMapX could not confirm whether the note was created.",
            );
          },
          async (finish) => {
            requireFeature();
            const state = requireWritable(await account.load(ctx.headers), "write_notes");

            // The centre is always recomputed here: a stale client coordinate
            // could place a public note somewhere the person never looked at.
            const element = await readElement(request.ref, "note");
            const { center } = await resolveGeometryAndCentre(element);
            if (!center) {
              throw new OsmContributionError(
                "ELEMENT_NOT_ELIGIBLE",
                422,
                "OpenMapX cannot determine a reliable location for this element.",
              );
            }

            let note: { id: number; status: "open" | "closed" };
            try {
              note = await client.createNote(
                { lat: center.lat, lon: center.lon, text: request.text },
                state.accessToken,
              );
            } catch (error) {
              throw mapUpstream(error, "note");
            }
            const result: OsmNoteResult = {
              noteId: note.id,
              noteUrl: config.noteUrl(note.id),
              status: note.status,
            };
            await finish({ kind: "success", at: now().toISOString(), result });
            return result;
          },
        ),
      );
    },
  };
}
