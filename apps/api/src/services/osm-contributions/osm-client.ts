/**
 * A deliberately small OSM API client.
 *
 * It exposes exactly the operations the contribution flow needs and takes no
 * absolute URL from a route or browser, so it can never become a general
 * proxy. Reads that need no identity are sent unauthenticated; the linked
 * account's bearer token is attached only to permission checks and mutations.
 *
 * Every response is read within a byte bound before parsing, and no upstream
 * body, header or URL is ever carried into an error.
 */
import { contactDomain, type OsmElementRef, userAgent } from "@openmapx/core";
import type { OsmConfig } from "../../utils/osm-config.js";
import {
  osmChangesetResponseSchema,
  osmElementResponseSchema,
  osmNoteResponseSchema,
  osmPermissionsResponseSchema,
  osmUserDetailsResponseSchema,
} from "./osm-schemas.js";
import { buildChangesetXml, buildElementXml } from "./osm-xml.js";
import {
  type OsmApiClient,
  type OsmChangeset,
  type OsmElement,
  type OsmFullResponse,
  type OsmNote,
  type OsmOperation,
  type OsmPermissions,
  OsmUpstreamError,
  type OsmUserDetails,
  type OsmWritableElement,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_FULL_BYTES = 5 * 1024 * 1024;
/** Plain-text success payloads are a single id or version. */
const MAX_TEXT_BYTES = 64;
/** A close response should be empty; tolerate a trivial body, never a page. */
const MAX_EMPTY_BYTES = 1024;
const MAX_RETRY_AFTER_SECONDS = 86_400;

export interface OsmClientDeps {
  config: OsmConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface RequestOptions {
  path: string;
  method?: "GET" | "POST" | "PUT";
  token?: string;
  accept: "application/json" | "text/plain" | "*/*";
  contentType?: "text/xml; charset=utf-8" | "application/json";
  body?: string;
  operation: OsmOperation;
  maxBytes: number;
  /** True when losing the response leaves the upstream state unknown. */
  mutating?: boolean;
}

function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return 0;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/** Read at most `maxBytes`, cancelling the rest. Returns null when exceeded. */
async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const value = await response.text().catch(() => null);
    if (value === null) return null;
    return Buffer.byteLength(value, "utf8") > maxBytes ? null : value;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return null;
    }
    if (chunk.done) break;
    if (!chunk.value) continue;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function positiveInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,19}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function createOsmApiClient(deps: OsmClientDeps): OsmApiClient {
  const { config } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // One descriptive agent for every contribution request, reusing the shared
  // helper so a deployment's own contact domain is what OSM sees.
  const agent = userAgent(`osm-contributions@${contactDomain()}`);

  async function request(options: RequestOptions): Promise<string> {
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": agent,
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.contentType) headers["Content-Type"] = options.contentType;

    let response: Response;
    try {
      response = await doFetch(config.apiUrl(options.path), {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Transport-level failure: the request may already have reached OSM.
      throw new OsmUpstreamError({
        status: null,
        operation: options.operation,
        requestMayHaveBeenApplied: options.mutating === true,
        reason: "upstream request failed before a response was received",
      });
    }

    if (!response.ok) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), now());
      // Drain within a small bound; the body may name an account or a block.
      await readBounded(response, MAX_EMPTY_BYTES);
      throw new OsmUpstreamError({
        status: response.status,
        operation: options.operation,
        retryAfterSeconds,
        // A non-2xx status is a completed exchange: the server decided.
        requestMayHaveBeenApplied: false,
        reason: `upstream responded ${response.status}`,
      });
    }

    const payload = await readBounded(response, options.maxBytes);
    if (payload === null) {
      throw new OsmUpstreamError({
        status: response.status,
        operation: options.operation,
        reason: "upstream response exceeded the accepted size",
      });
    }
    return payload;
  }

  function invalid(operation: OsmOperation, reason: string): OsmUpstreamError {
    return new OsmUpstreamError({ status: null, operation, reason });
  }

  async function requestJson(options: RequestOptions): Promise<unknown> {
    const raw = await request(options);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw invalid(options.operation, "upstream returned malformed JSON");
    }
  }

  function toElement(raw: unknown, operation: OsmOperation): OsmElement {
    const parsed = osmElementResponseSchema.safeParse(raw);
    if (!parsed.success) throw invalid(operation, "upstream element failed validation");
    return normalizeElements(parsed.data.elements, operation).primary;
  }

  /** Pick the single primary element and keep every companion node. */
  function normalizeElements(
    elements: Array<Record<string, unknown>>,
    operation: OsmOperation,
    ref?: OsmElementRef,
  ): { primary: OsmElement; nodes: Array<{ id: number; lat: number; lon: number }> } {
    const typed = elements as unknown as OsmElement[];
    const candidates = ref
      ? typed.filter((element) => element.type === ref.type && element.id === ref.id)
      : typed;
    const primary = candidates.at(-1);
    if (!primary || candidates.length === 0) {
      throw invalid(operation, "upstream response did not contain the requested element");
    }
    if (!ref && candidates.length !== 1) {
      throw invalid(operation, "upstream response did not contain exactly one element");
    }
    const nodes: Array<{ id: number; lat: number; lon: number }> = [];
    for (const element of typed) {
      if (element.type !== "node") continue;
      if (ref && element.type === ref.type && element.id === ref.id) continue;
      nodes.push({ id: element.id, lat: element.lat, lon: element.lon });
    }
    return { primary: withTags(primary), nodes };
  }

  function withTags(element: OsmElement): OsmElement {
    return { ...element, tags: element.tags ?? {} };
  }

  return {
    async getPermissions(token: string): Promise<OsmPermissions> {
      const raw = await requestJson({
        path: "api/0.6/permissions.json",
        token,
        accept: "application/json",
        operation: "capabilities",
        maxBytes: MAX_JSON_BYTES,
      });
      const parsed = osmPermissionsResponseSchema.safeParse(raw);
      if (!parsed.success) throw invalid("capabilities", "upstream permissions failed validation");
      const granted = new Set(parsed.data.permissions);
      return {
        allowWriteApi: granted.has("allow_write_api"),
        allowWriteNotes: granted.has("allow_write_notes"),
      };
    },

    async getUserDetails(token: string): Promise<OsmUserDetails> {
      const raw = await requestJson({
        path: "api/0.6/user/details.json",
        token,
        accept: "application/json",
        operation: "capabilities",
        maxBytes: MAX_JSON_BYTES,
      });
      const parsed = osmUserDetailsResponseSchema.safeParse(raw);
      if (!parsed.success) throw invalid("capabilities", "upstream user details failed validation");
      const user = parsed.data.user;
      return {
        id: user.id,
        displayName: user.display_name,
        contributorTermsAgreed: user.contributor_terms.agreed,
        activeBlock: (user.blocks?.received.active ?? 0) > 0,
      };
    },

    async getElement(ref: OsmElementRef): Promise<OsmElement> {
      const raw = await requestJson({
        path: `api/0.6/${ref.type}/${ref.id}.json`,
        accept: "application/json",
        operation: "context",
        maxBytes: MAX_JSON_BYTES,
      });
      const element = toElement(raw, "context");
      if (element.type !== ref.type || element.id !== ref.id) {
        throw invalid("context", "upstream returned a different element");
      }
      return element;
    },

    async getFullElement(ref: OsmElementRef): Promise<OsmFullResponse> {
      const raw = await requestJson({
        path: `api/0.6/${ref.type}/${ref.id}/full.json`,
        accept: "application/json",
        operation: "context",
        maxBytes: MAX_FULL_BYTES,
      });
      const parsed = osmElementResponseSchema.safeParse(raw);
      if (!parsed.success) throw invalid("context", "upstream full element failed validation");
      const { primary, nodes } = normalizeElements(
        parsed.data.elements as unknown as Array<Record<string, unknown>>,
        "context",
        ref,
      );
      return { primary, nodes };
    },

    async createChangeset(tags: Readonly<Record<string, string>>, token: string): Promise<number> {
      const raw = await request({
        path: "api/0.6/changeset/create",
        method: "PUT",
        token,
        accept: "text/plain",
        contentType: "text/xml; charset=utf-8",
        body: buildChangesetXml(tags),
        operation: "publish",
        maxBytes: MAX_TEXT_BYTES,
        mutating: true,
      });
      const id = positiveInteger(raw);
      if (id === null) throw invalid("publish", "upstream returned an unusable changeset id");
      return id;
    },

    async updateElement(element: OsmWritableElement, token: string): Promise<number> {
      const raw = await request({
        path: `api/0.6/${element.type}/${element.id}`,
        method: "PUT",
        token,
        accept: "text/plain",
        contentType: "text/xml; charset=utf-8",
        body: buildElementXml(element),
        operation: "publish",
        maxBytes: MAX_TEXT_BYTES,
        mutating: true,
      });
      const version = positiveInteger(raw);
      if (version === null) throw invalid("publish", "upstream returned an unusable version");
      return version;
    },

    async closeChangeset(changesetId: number, token: string): Promise<void> {
      await request({
        path: `api/0.6/changeset/${changesetId}/close`,
        method: "PUT",
        token,
        accept: "*/*",
        operation: "close_changeset",
        maxBytes: MAX_EMPTY_BYTES,
        mutating: true,
      });
    },

    async getChangeset(changesetId: number): Promise<OsmChangeset> {
      const raw = await requestJson({
        path: `api/0.6/changeset/${changesetId}.json`,
        accept: "application/json",
        operation: "reconcile",
        maxBytes: MAX_JSON_BYTES,
      });
      const parsed = osmChangesetResponseSchema.safeParse(raw);
      if (!parsed.success) throw invalid("reconcile", "upstream changeset failed validation");
      const changeset = parsed.data.changeset ?? parsed.data.elements?.[0];
      if (!changeset) throw invalid("reconcile", "upstream changeset was empty");
      return { id: changeset.id, open: changeset.open };
    },

    async createNote(
      input: { lat: number; lon: number; text: string },
      token: string,
    ): Promise<OsmNote> {
      const raw = await requestJson({
        path: "api/0.6/notes.json",
        method: "POST",
        token,
        accept: "application/json",
        contentType: "application/json",
        body: JSON.stringify({ lat: input.lat, lon: input.lon, text: input.text }),
        operation: "note",
        maxBytes: MAX_JSON_BYTES,
        mutating: true,
      });
      const parsed = osmNoteResponseSchema.safeParse(raw);
      if (!parsed.success) throw invalid("note", "upstream note failed validation");
      return {
        id: parsed.data.properties.id,
        status: parsed.data.properties.status === "closed" ? "closed" : "open",
      };
    },
  };
}
