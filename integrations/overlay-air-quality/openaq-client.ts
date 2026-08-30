import type { Pollutant } from "@openmapx/air-quality";
import type { HttpClient, HttpResponse, UpstreamRuntime } from "@openmapx/integration-framework";
import type { z } from "zod";
import { createOpenAQQuota } from "./quota.js";
import {
  type OpenAQHour,
  type OpenAQLatest,
  type OpenAQLicense,
  type OpenAQLocation,
  openAQHoursResponseSchema,
  openAQLatestResponseSchema,
  openAQLicensesResponseSchema,
  openAQLocationsResponseSchema,
} from "./schemas.js";

const OPENAQ_ORIGIN = "https://api.openaq.org";
const OPENAQ_PREFIX = "/v3";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 3;
const RESPONSE_HEADERS = [
  "retry-after",
  "x-ratelimit-used",
  "x-ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
] as const;

const parameterIds: Partial<Record<Pollutant, readonly number[]>> = {
  pm10: [1],
  pm25: [2],
  o3: [3, 10],
  no2: [5, 7],
  so2: [6, 9],
  co: [4, 8],
  no: [35],
};

export type OpenAQClientErrorCode =
  | "unauthorized"
  | "forbidden"
  | "quota_exhausted"
  | "upstream_failure"
  | "invalid_request"
  | "invalid_response";

export class OpenAQClientError extends Error {
  constructor(
    readonly code: OpenAQClientErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "OpenAQClientError";
  }
}

export interface OpenAQPage<T> {
  items: T[];
  pages: number;
  truncated: boolean;
}

export interface OpenAQLocationQuery {
  bbox?: readonly [number, number, number, number];
  point?: { latitude: number; longitude: number; radiusMeters: number };
  pollutants?: readonly Pollutant[];
  pageSize?: number;
  maxPages?: number;
}

export interface OpenAQClient {
  listLocations(
    query: OpenAQLocationQuery,
    signal: AbortSignal,
  ): Promise<OpenAQPage<OpenAQLocation>>;
  getLocation(locationId: number, signal: AbortSignal): Promise<OpenAQLocation | null>;
  getLatest(locationId: number, signal: AbortSignal): Promise<OpenAQPage<OpenAQLatest>>;
  listLicenses(signal: AbortSignal): Promise<OpenAQPage<OpenAQLicense>>;
  getSensorHours(
    sensorId: number,
    window: { from: string; to: string; maxSamples: number },
    signal: AbortSignal,
  ): Promise<OpenAQPage<OpenAQHour>>;
}

function safePositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0)
    throw new OpenAQClientError("invalid_request", "Pagination bounds must be positive integers");
  return Math.min(value, maximum);
}

function parseFound(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function retryAt(headers: Readonly<Record<string, string>>, now = Date.now()): number | null {
  const raw = headers["retry-after"] ?? headers["x-ratelimit-reset"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? date : null;
}

function statusError(status: number, headers: Readonly<Record<string, string>>): OpenAQClientError {
  if (status === 401)
    return new OpenAQClientError("unauthorized", "OpenAQ rejected the API key", status);
  if (status === 403)
    return new OpenAQClientError("forbidden", "OpenAQ denied this request", status);
  if (status === 429)
    return new OpenAQClientError(
      "quota_exhausted",
      "OpenAQ quota is exhausted",
      status,
      retryAt(headers),
    );
  if (status >= 500)
    return new OpenAQClientError("upstream_failure", `OpenAQ returned HTTP ${status}`, status);
  return new OpenAQClientError("invalid_request", `OpenAQ returned HTTP ${status}`, status);
}

function fixedUrl(path: string, params?: URLSearchParams): string {
  if (!path.startsWith("/") || path.includes(".."))
    throw new OpenAQClientError("invalid_request", "Invalid OpenAQ path");
  const url = new URL(`${OPENAQ_PREFIX}${path}`, OPENAQ_ORIGIN);
  if (params) url.search = params.toString();
  return url.toString();
}

function validId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new OpenAQClientError("invalid_request", `${label} must be a positive integer`);
  return value;
}

export function createOpenAQClient(input: {
  http: HttpClient;
  upstreamRuntime: UpstreamRuntime;
  apiKey: string;
}): OpenAQClient {
  const quota = createOpenAQQuota(input.upstreamRuntime);

  async function request<T>(
    path: string,
    params: URLSearchParams,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const decision = await quota.consume();
    if (!decision.allowed)
      throw new OpenAQClientError(
        "quota_exhausted",
        "OpenAQ quota is unavailable",
        null,
        decision.retryAt,
      );
    let response: HttpResponse<unknown>;
    try {
      response = await input.http.getResponse<unknown>(fixedUrl(path, params), {
        headers: { "X-API-Key": input.apiKey },
        signal,
        timeoutMs: 4_000,
        maxBytes: MAX_RESPONSE_BYTES,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        contentTypes: ["application/json"],
        responseHeaders: RESPONSE_HEADERS,
        redirect: "error",
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const detail = error instanceof Error ? error.message : "unknown error";
      const code = /content type|response body|response size|bytes|json|parse/i.test(detail)
        ? "invalid_response"
        : "upstream_failure";
      throw new OpenAQClientError(code, `OpenAQ response could not be safely read: ${detail}`);
    }
    await quota.observeResponse(response.status, response.headers);
    if (response.status < 200 || response.status >= 300)
      throw statusError(response.status, response.headers);
    const parsed = schema.safeParse(response.body);
    if (!parsed.success)
      throw new OpenAQClientError(
        "invalid_response",
        `OpenAQ response schema mismatch: ${parsed.error.issues[0]?.message ?? "invalid payload"}`,
        response.status,
      );
    return parsed.data;
  }

  async function paged<T>(options: {
    path: string;
    params: URLSearchParams;
    schema: z.ZodType<{ meta: { found?: number | string | null }; results: T[] }>;
    pageSize: number;
    maxPages: number;
    maxItems: number;
    signal: AbortSignal;
  }): Promise<OpenAQPage<T>> {
    const items: T[] = [];
    let pages = 0;
    let definitelyMore = false;
    for (let page = 1; page <= options.maxPages; page++) {
      const params = new URLSearchParams(options.params);
      params.set("limit", String(options.pageSize));
      params.set("page", String(page));
      const payload = await request(options.path, params, options.schema, options.signal);
      pages += 1;
      const remaining = options.maxItems - items.length;
      items.push(...payload.results.slice(0, Math.max(0, remaining)));
      const found = parseFound(payload.meta.found);
      definitelyMore =
        payload.results.length > remaining ||
        (found !== null ? items.length < found : payload.results.length >= options.pageSize);
      if (!definitelyMore || items.length >= options.maxItems) break;
    }
    return { items, pages, truncated: definitelyMore };
  }

  async function listOneBbox(
    query: OpenAQLocationQuery,
    bbox: readonly [number, number, number, number] | undefined,
    signal: AbortSignal,
  ): Promise<OpenAQPage<OpenAQLocation>> {
    if ((bbox ? 1 : 0) + (query.point ? 1 : 0) !== 1)
      throw new OpenAQClientError(
        "invalid_request",
        "Exactly one OpenAQ spatial query is required",
      );
    if (
      bbox &&
      (bbox.some((coordinate) => !Number.isFinite(coordinate)) ||
        bbox[0] < -180 ||
        bbox[0] > 180 ||
        bbox[2] < -180 ||
        bbox[2] > 180 ||
        bbox[1] < -90 ||
        bbox[1] > 90 ||
        bbox[3] < -90 ||
        bbox[3] > 90 ||
        bbox[1] >= bbox[3])
    )
      throw new OpenAQClientError("invalid_request", "OpenAQ bbox is outside WGS84 bounds");
    const pageSize = safePositiveInteger(query.pageSize, DEFAULT_PAGE_SIZE, 200);
    const maxPages = safePositiveInteger(query.maxPages, DEFAULT_MAX_PAGES, 5);
    const params = new URLSearchParams({
      monitor: "true",
      mobile: "false",
      order_by: "id",
      sort_order: "asc",
    });
    if (bbox) params.set("bbox", bbox.join(","));
    if (query.point) {
      if (
        !Number.isFinite(query.point.latitude) ||
        query.point.latitude < -90 ||
        query.point.latitude > 90 ||
        !Number.isFinite(query.point.longitude) ||
        query.point.longitude < -180 ||
        query.point.longitude > 180 ||
        !Number.isFinite(query.point.radiusMeters) ||
        query.point.radiusMeters <= 0 ||
        query.point.radiusMeters > 25_000
      )
        throw new OpenAQClientError(
          "invalid_request",
          "OpenAQ radius must be from 1 to 25000 metres",
        );
      params.set("coordinates", `${query.point.latitude},${query.point.longitude}`);
      params.set("radius", String(Math.floor(query.point.radiusMeters)));
    }
    const ids = [
      ...new Set((query.pollutants ?? []).flatMap((pollutant) => parameterIds[pollutant] ?? [])),
    ];
    if (ids.length > 0) params.set("parameters_id", ids.join(","));
    return paged({
      path: "/locations",
      params,
      schema: openAQLocationsResponseSchema,
      pageSize,
      maxPages,
      maxItems: pageSize * maxPages,
      signal,
    });
  }

  return {
    async listLocations(query, signal) {
      const bbox = query.bbox;
      if (!bbox || bbox[0] <= bbox[2]) return listOneBbox(query, bbox, signal);
      const left = await listOneBbox(query, [bbox[0], bbox[1], 180, bbox[3]], signal);
      const right = await listOneBbox(query, [-180, bbox[1], bbox[2], bbox[3]], signal);
      const byId = new Map(
        [...left.items, ...right.items].map((location) => [location.id, location]),
      );
      return {
        items: [...byId.values()].sort((a, b) => a.id - b.id),
        pages: left.pages + right.pages,
        truncated: left.truncated || right.truncated,
      };
    },

    async getLocation(locationId, signal) {
      const payload = await request(
        `/locations/${validId(locationId, "location id")}`,
        new URLSearchParams(),
        openAQLocationsResponseSchema,
        signal,
      );
      return payload.results[0] ?? null;
    },

    async getLatest(locationId, signal) {
      const params = new URLSearchParams();
      const page = await paged({
        path: `/locations/${validId(locationId, "location id")}/latest`,
        params,
        schema: openAQLatestResponseSchema,
        pageSize: 100,
        maxPages: 2,
        maxItems: 200,
        signal,
      });
      const newest = new Map<number, OpenAQLatest>();
      for (const item of page.items) {
        const existing = newest.get(item.sensorsId);
        if (!existing || Date.parse(item.datetime.utc) > Date.parse(existing.datetime.utc))
          newest.set(item.sensorsId, item);
      }
      return { ...page, items: [...newest.values()].sort((a, b) => a.sensorsId - b.sensorsId) };
    },

    async listLicenses(signal) {
      return paged({
        path: "/licenses",
        params: new URLSearchParams({ order_by: "id", sort_order: "asc" }),
        schema: openAQLicensesResponseSchema,
        pageSize: 100,
        maxPages: 3,
        maxItems: 300,
        signal,
      });
    },

    async getSensorHours(sensorId, window, signal) {
      if (
        !Number.isFinite(Date.parse(window.from)) ||
        !Number.isFinite(Date.parse(window.to)) ||
        Date.parse(window.from) >= Date.parse(window.to)
      )
        throw new OpenAQClientError("invalid_request", "OpenAQ hourly window is invalid");
      const maxSamples = safePositiveInteger(window.maxSamples, 48, 168);
      const params = new URLSearchParams({ datetime_from: window.from, datetime_to: window.to });
      const page = await paged({
        path: `/sensors/${validId(sensorId, "sensor id")}/hours`,
        params,
        schema: openAQHoursResponseSchema,
        pageSize: Math.min(100, maxSamples),
        maxPages: Math.min(3, Math.ceil(maxSamples / 100)),
        maxItems: maxSamples,
        signal,
      });
      const validIntervals = page.items.filter((item) => {
        const start = Date.parse(item.period?.datetimeFrom?.utc ?? "");
        const end = Date.parse(item.period?.datetimeTo?.utc ?? "");
        return Number.isFinite(start) && Number.isFinite(end) && start < end;
      });
      validIntervals.sort(
        (left, right) =>
          Date.parse(left.period?.datetimeTo?.utc ?? "") -
          Date.parse(right.period?.datetimeTo?.utc ?? ""),
      );
      return { ...page, items: validIntervals };
    },
  };
}
