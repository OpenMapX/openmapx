/**
 * TanStack Query hooks for the OSM contribution flow.
 *
 * Every payload — success and failure — is validated against the shared
 * contract before the UI sees it, so an unexpected server or proxy response
 * becomes a typed safe error rather than something rendered verbatim.
 *
 * Nothing here retries a mutation, and the element context is always fetched
 * fresh: a contribution must start from live OpenStreetMap data.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, isApiClientError } from "../api/client";
import { API_ENDPOINTS } from "../api/endpoints";
import {
  osmCategorySuggestionSchema,
  osmContributionCapabilitiesSchema,
  osmContributionContextSchema,
  osmContributionErrorBodySchema,
  osmContributionPreviewSchema,
  osmContributionPublishResultSchema,
  osmNoteResultSchema,
} from "../schemas/osmContribution";
import type {
  OsmCategorySuggestion,
  OsmContributionCapabilities,
  OsmContributionContext,
  OsmContributionErrorBody,
  OsmContributionLocale,
  OsmContributionPreview,
  OsmContributionPreviewRequest,
  OsmContributionPublishRequest,
  OsmContributionPublishResult,
  OsmElementRef,
  OsmGeometry,
  OsmNoteRequest,
  OsmNoteResult,
} from "../types/osmContribution";

/** Shortest query that is worth sending to the bounded category search. */
export const OSM_CATEGORY_MIN_QUERY_LENGTH = 2;

export const osmContributionKeys = {
  all: ["osmContributions"] as const,
  capabilities: () => [...osmContributionKeys.all, "capabilities"] as const,
  context: (ref: OsmElementRef) =>
    [...osmContributionKeys.all, "context", ref.type, ref.id] as const,
  categories: (ref: OsmElementRef, geometry: OsmGeometry, locale: string, q: string) =>
    [...osmContributionKeys.all, "categories", ref.type, ref.id, geometry, locale, q] as const,
};

/**
 * A failure the contribution UI can render. Always one of the closed codes;
 * the raw transport payload never reaches a component.
 */
export class OsmContributionRequestError extends Error implements OsmContributionErrorBody {
  readonly code: OsmContributionErrorBody["code"];
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly context?: OsmContributionContext;
  readonly inspect?: { changesetUrl?: string; elementUrl?: string };

  constructor(status: number, body: OsmContributionErrorBody) {
    super(body.message);
    this.name = "OsmContributionRequestError";
    this.status = status;
    this.code = body.code;
    this.retryAfterSeconds = body.retryAfterSeconds;
    this.context = body.context;
    this.inspect = body.inspect;
  }
}

const GENERIC_FAILURE: OsmContributionErrorBody = {
  code: "OSM_UNAVAILABLE",
  message: "Something went wrong. Please try again.",
};

/**
 * Translate a transport failure into a typed contribution error, but only when
 * its payload actually validates. Anything else becomes a generic safe error so
 * upstream text can never be displayed.
 */
function toContributionError(error: unknown): OsmContributionRequestError {
  if (!isApiClientError(error)) {
    return new OsmContributionRequestError(0, GENERIC_FAILURE);
  }
  const parsed = osmContributionErrorBodySchema.safeParse(error.payload);
  if (!parsed.success) {
    return new OsmContributionRequestError(error.status, {
      ...GENERIC_FAILURE,
      ...(error.retryAfterSeconds === null ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    });
  }
  return new OsmContributionRequestError(error.status, {
    ...parsed.data,
    // Prefer the body's own value; fall back to the transport header.
    ...(parsed.data.retryAfterSeconds === undefined && error.retryAfterSeconds !== null
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  });
}

const INVALID_RESPONSE: OsmContributionErrorBody = {
  code: "UPSTREAM_INVALID",
  message: "OpenMapX received an unexpected response.",
};

function parseOrThrow<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OsmContributionRequestError(0, INVALID_RESPONSE);
  return parsed.data as T;
}

async function run<T>(
  schema: Parameters<typeof parseOrThrow>[0],
  request: () => Promise<unknown>,
): Promise<T> {
  try {
    return parseOrThrow<T>(schema, await request());
  } catch (error) {
    if (error instanceof OsmContributionRequestError) throw error;
    throw toContributionError(error);
  }
}

export function useOsmContributionCapabilities(enabled: boolean) {
  return useQuery<OsmContributionCapabilities, OsmContributionRequestError>({
    queryKey: osmContributionKeys.capabilities(),
    queryFn: ({ signal }) =>
      run(osmContributionCapabilitiesSchema, () =>
        apiClient.get(API_ENDPOINTS.osmContributionCapabilities, undefined, { signal }),
      ),
    enabled,
    // Account and permission state can change in another tab; never cache it.
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
}

export function useOsmContributionContext(
  ref: OsmElementRef | undefined,
  locale: OsmContributionLocale,
  enabled: boolean,
) {
  return useQuery<OsmContributionContext, OsmContributionRequestError>({
    queryKey: ref
      ? osmContributionKeys.context(ref)
      : [...osmContributionKeys.all, "context", "none"],
    queryFn: ({ signal }) =>
      run(osmContributionContextSchema, () =>
        apiClient.get(
          `${API_ENDPOINTS.osmContributions}/${ref?.type}/${ref?.id}`,
          { locale },
          { signal },
        ),
      ),
    enabled: enabled && ref !== undefined,
    // A contribution must always begin from live OpenStreetMap data.
    staleTime: 0,
    refetchOnMount: "always",
    // One retry, and only for a transport/5xx failure.
    retry: (count, error) => count < 1 && (error.status === 0 || error.status >= 500),
  });
}

export interface OsmCategorySearchInput {
  ref: OsmElementRef;
  geometry: OsmGeometry;
  locale: OsmContributionLocale;
  query: string;
}

export function useOsmContributionCategories(input: OsmCategorySearchInput, enabled: boolean) {
  const query = input.query.trim();
  const searchable =
    enabled && input.geometry !== "unknown" && query.length >= OSM_CATEGORY_MIN_QUERY_LENGTH;
  return useQuery<OsmCategorySuggestion[], OsmContributionRequestError>({
    queryKey: osmContributionKeys.categories(input.ref, input.geometry, input.locale, query),
    queryFn: ({ signal }) =>
      run(osmCategorySuggestionSchema.array(), () =>
        apiClient.get(
          API_ENDPOINTS.osmContributionCategories,
          {
            type: input.ref.type,
            id: String(input.ref.id),
            geometry: input.geometry,
            locale: input.locale,
            q: query,
          },
          { signal },
        ),
      ),
    enabled: searchable,
    staleTime: 60_000,
    retry: false,
  });
}

export function usePreviewOsmContribution() {
  return useMutation<
    OsmContributionPreview,
    OsmContributionRequestError,
    OsmContributionPreviewRequest
  >({
    mutationFn: (request) =>
      run(osmContributionPreviewSchema, () =>
        apiClient.post(API_ENDPOINTS.osmContributionPreview, request),
      ),
    retry: false,
  });
}

export function usePublishOsmContribution() {
  const queryClient = useQueryClient();
  return useMutation<
    OsmContributionPublishResult,
    OsmContributionRequestError,
    OsmContributionPublishRequest
  >({
    mutationFn: (request) =>
      run(osmContributionPublishResultSchema, () =>
        apiClient.post(API_ENDPOINTS.osmContributionPublish, request),
      ),
    retry: false,
    onSuccess: (_result, request) => {
      // Only the contribution context is refreshed here. The place record has
      // mixed provenance and upstream propagation lags, so it is invalidated
      // when the editor closes rather than patched with submitted values.
      void queryClient.invalidateQueries({ queryKey: osmContributionKeys.context(request.ref) });
    },
  });
}

export function useCreateOsmNote() {
  return useMutation<OsmNoteResult, OsmContributionRequestError, OsmNoteRequest>({
    mutationFn: (request) =>
      run(osmNoteResultSchema, () => apiClient.post(API_ENDPOINTS.osmContributionNotes, request)),
    retry: false,
  });
}

/**
 * Invalidate what a finished contribution may have changed. Called on close,
 * never while the success view is still authoritative.
 */
export function useInvalidateAfterContribution() {
  const queryClient = useQueryClient();
  return (ref: OsmElementRef | undefined) => {
    if (ref) {
      void queryClient.invalidateQueries({ queryKey: osmContributionKeys.context(ref) });
    }
    void queryClient.invalidateQueries({ queryKey: ["place"] });
  };
}
