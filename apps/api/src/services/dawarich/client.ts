import {
  SafeFetchHttpError,
  type SafeFetchJsonOptions,
  type SafeJsonResponse,
  safeFetchJsonResponse,
} from "@openmapx/core/server";
import { ZodError, type z } from "zod";
import {
  currentUserSchema,
  type DawarichCurrentUser,
  type DawarichSettings,
  type DawarichTimelineResponse,
  type DawarichTrackFeatureCollection,
  settingsSchema,
  timelineResponseSchema,
  tracksFeatureCollectionSchema,
} from "./contracts";
import { DAWARICH_LIMITS, type DawarichLimits } from "./limits";

export type FetchJsonResponse = <T>(
  url: string,
  options: SafeFetchJsonOptions,
) => Promise<SafeJsonResponse<T>>;

export type DawarichRange = { startAt: string; endAt: string };
export type DawarichErrorKind =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "invalid_response"
  | "page_limit";

export class DawarichClientError extends Error {
  readonly kind: DawarichErrorKind;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: DawarichErrorKind,
    status: number | null = null,
    retryAfterSeconds: number | null = null,
  ) {
    super(`Dawarich request failed: ${kind}`);
    this.name = "DawarichClientError";
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface DawarichClientOptions {
  baseUrl: string;
  apiKey: string;
  allowPrivateHosts?: string[];
  limits?: Partial<DawarichLimits>;
  fetchJsonResponse?: FetchJsonResponse;
}

export interface DawarichTracksPage {
  data: DawarichTrackFeatureCollection;
  pagination: { currentPage: number; totalPages: number; totalCount: number };
}

function normalizeBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DawarichClientError("invalid_response");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new DawarichClientError("invalid_response");
  }
  return new URL(parsed.origin);
}

function mapHttpError(error: SafeFetchHttpError): DawarichClientError {
  const kind: DawarichErrorKind =
    error.status === 401
      ? "unauthorized"
      : error.status === 403
        ? "forbidden"
        : error.status === 429
          ? "rate_limited"
          : error.status >= 500
            ? "unavailable"
            : "invalid_response";
  return new DawarichClientError(kind, error.status, error.retryAfterSeconds);
}

function parseIntegerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export class DawarichClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly allowPrivateHosts: string[];
  private readonly limits: DawarichLimits;
  private readonly fetchJsonResponse: FetchJsonResponse;

  constructor(options: DawarichClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.allowPrivateHosts = options.allowPrivateHosts ?? [];
    this.limits = { ...DAWARICH_LIMITS, ...options.limits };
    this.fetchJsonResponse = options.fetchJsonResponse ?? safeFetchJsonResponse;
  }

  async getCurrentUser(): Promise<DawarichCurrentUser> {
    return this.request(
      "/api/v1/users/me",
      currentUserSchema,
      this.limits.timelineOrSettingsMaxBytes,
    );
  }

  async getSettings(): Promise<DawarichSettings> {
    return this.request("/api/v1/settings", settingsSchema, this.limits.timelineOrSettingsMaxBytes);
  }

  async getTimeline(range: DawarichRange, distanceUnit: string): Promise<DawarichTimelineResponse> {
    return this.request(
      "/api/v1/timeline",
      timelineResponseSchema,
      this.limits.timelineOrSettingsMaxBytes,
      {
        start_at: range.startAt,
        end_at: range.endAt,
        distance_unit: distanceUnit,
      },
    );
  }

  async getTracksPage(range: DawarichRange, page: number): Promise<DawarichTracksPage> {
    if (!Number.isInteger(page) || page < 1 || page > this.limits.maxTrackPages) {
      throw new DawarichClientError("page_limit");
    }
    const result = await this.requestWithResponse(
      "/api/v1/tracks",
      tracksFeatureCollectionSchema,
      this.limits.tracksPageMaxBytes,
      ["application/json", "application/geo+json"],
      {
        start_at: range.startAt,
        end_at: range.endAt,
        page: String(page),
        per_page: String(this.limits.tracksPerPage),
      },
    );
    const currentPage = parseIntegerHeader(result.headers, "x-current-page");
    const totalPages = parseIntegerHeader(result.headers, "x-total-pages");
    const totalCount = parseIntegerHeader(result.headers, "x-total-count");
    if (
      currentPage === null ||
      totalPages === null ||
      totalCount === null ||
      currentPage !== page ||
      currentPage < 1 ||
      totalPages > this.limits.maxTrackPages ||
      totalCount > this.limits.maxTrackFeaturesPerDay ||
      currentPage > Math.max(totalPages, 1)
    ) {
      throw new DawarichClientError("invalid_response");
    }
    if (result.data.features.length > this.limits.tracksPerPage) {
      throw new DawarichClientError("page_limit");
    }
    return { data: result.data, pagination: { currentPage, totalPages, totalCount } };
  }

  private request<T extends z.ZodType>(
    path: string,
    schema: T,
    maxBytes: number,
    query?: Record<string, string>,
  ): Promise<z.infer<T>> {
    return this.requestWithResponse(path, schema, maxBytes, ["application/json"], query).then(
      (result) => result.data,
    );
  }

  private async requestWithResponse<T extends z.ZodType>(
    path: string,
    schema: T,
    maxBytes: number,
    acceptedContentTypes: string[],
    query?: Record<string, string>,
  ): Promise<SafeJsonResponse<z.infer<T>>> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const options: SafeFetchJsonOptions = {
      headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
      allowPrivateHosts: this.allowPrivateHosts,
      allowedRedirectHosts: [this.baseUrl.hostname],
      maxRedirects: this.limits.maxRedirects,
      timeoutMs: this.limits.requestTimeoutMs,
      maxBytes,
      acceptedContentTypes,
    };
    try {
      const response = await this.fetchJsonResponse<unknown>(url.toString(), options);
      return { ...response, data: schema.parse(response.data) };
    } catch (error) {
      if (error instanceof DawarichClientError) throw error;
      if (error instanceof SafeFetchHttpError) throw mapHttpError(error);
      if (error instanceof ZodError) throw new DawarichClientError("invalid_response");
      throw new DawarichClientError("unavailable");
    }
  }
}
