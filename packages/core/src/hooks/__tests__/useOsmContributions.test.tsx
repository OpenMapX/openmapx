import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, apiClient } from "../../api/client";
import { createQueryWrapper, createTestQueryClient } from "../../test/queryWrapper";
import type { OsmContributionContext, OsmElementRef } from "../../types/osmContribution";
import { useCapabilities } from "../useCapabilities";
import {
  osmContributionKeys,
  useCreateOsmNote,
  useOsmContributionCapabilities,
  useOsmContributionCategories,
  useOsmContributionContext,
  usePreviewOsmContribution,
  usePublishOsmContribution,
} from "../useOsmContributions";

const REF: OsmElementRef = { type: "node", id: 12 };
const UUID = "3f4b2a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

const CAPABILITIES = {
  enabled: true,
  directEditingEnabled: true,
  linked: true,
  canWriteApi: true,
  canWriteNotes: true,
  contributorTermsAgreed: true,
  activeBlock: false,
  requiredScopes: [],
  actions: { reauthorize: false },
};

const CONTEXT: OsmContributionContext = {
  ref: REF,
  version: 4,
  geometry: "point",
  center: { lat: 52.5, lon: 13.4 },
  displayName: "Café Central",
  currentPreset: { status: "matched", presetId: "amenity/cafe", name: "Cafe" },
  fields: [
    {
      kind: "text",
      field: "name",
      label: "Name",
      currentValue: "Café Central",
      maxCodePoints: 255,
      enabled: true,
    },
  ],
  advancedEditorUrl: "https://www.openstreetmap.org/edit?editor=id&node=12",
  elementUrl: "https://www.openstreetmap.org/node/12",
  fetchedAt: "2026-08-10T09:00:00.000Z",
};

const PREVIEW = {
  ref: REF,
  baseVersion: 4,
  changes: [{ field: "name", label: "Name", action: "set", before: "A", after: "B" }],
  tagDiff: { add: [], replace: [{ key: "name", from: "A", to: "B" }], remove: [] },
  warnings: [],
  requiresReview: false,
};

function wrapper() {
  return createQueryWrapper(createTestQueryClient());
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("query keys", () => {
  it("are stable and scoped", () => {
    expect(osmContributionKeys.capabilities()).toEqual(["osmContributions", "capabilities"]);
    expect(osmContributionKeys.context(REF)).toEqual(["osmContributions", "context", "node", 12]);
    expect(osmContributionKeys.categories(REF, "point", "en", "cafe")).toEqual([
      "osmContributions",
      "categories",
      "node",
      12,
      "point",
      "en",
      "cafe",
    ]);
  });
});

describe("useCapabilities", () => {
  it("fails closed while the public capability response is missing or loading", async () => {
    vi.spyOn(apiClient, "get").mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useCapabilities(), { wrapper: wrapper() });
    expect(result.current.osmContributionsEnabled).toBe(false);
  });

  it("fails closed on an invalid or absent feature bit", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({ services: {} });
    const { result } = renderHook(() => useCapabilities(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.osmContributionsEnabled).toBe(false);
  });

  it("is true only for an explicit true", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      services: {},
      features: { osmContributions: true },
    });
    const { result } = renderHook(() => useCapabilities(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.osmContributionsEnabled).toBe(true));
  });

  it("stays false when the request fails", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(new ApiClientError(500, null, null));
    const { result } = renderHook(() => useCapabilities(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.osmContributionsEnabled).toBe(false);
  });
});

describe("useOsmContributionCapabilities", () => {
  it("does not fetch while disabled", () => {
    const get = vi.spyOn(apiClient, "get");
    renderHook(() => useOsmContributionCapabilities(false), { wrapper: wrapper() });
    expect(get).not.toHaveBeenCalled();
  });

  it("validates the response against the shared schema", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue(CAPABILITIES);
    const { result } = renderHook(() => useOsmContributionCapabilities(true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.canWriteApi).toBe(true);
  });

  it("rejects an invalid response rather than passing it through", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({ enabled: "yes" });
    const { result } = renderHook(() => useOsmContributionCapabilities(true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useOsmContributionContext", () => {
  it("requests the element path and always refetches live data", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(CONTEXT);
    const { result } = renderHook(() => useOsmContributionContext(REF, "de", true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith(
      "/api/osm/contributions/node/12",
      { locale: "de" },
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result.current.data?.version).toBe(4);
  });

  it("is disabled without a ref", () => {
    const get = vi.spyOn(apiClient, "get");
    renderHook(() => useOsmContributionContext(undefined, "en", true), { wrapper: wrapper() });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("useOsmContributionCategories", () => {
  it("passes bounded query parameters", async () => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockResolvedValue([{ presetId: "amenity/cafe", name: "Cafe", geometry: ["point"] }]);
    const { result } = renderHook(
      () =>
        useOsmContributionCategories(
          { ref: REF, geometry: "point", locale: "en", query: "cafe" },
          true,
        ),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith(
      "/api/osm/contributions/categories",
      { type: "node", id: "12", geometry: "point", locale: "en", q: "cafe" },
      expect.anything(),
    );
  });

  it("does not search for fewer than two trimmed characters", () => {
    const get = vi.spyOn(apiClient, "get");
    for (const query of ["", " ", "a", " a "]) {
      renderHook(
        () =>
          useOsmContributionCategories({ ref: REF, geometry: "point", locale: "en", query }, true),
        { wrapper: wrapper() },
      );
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("does not search for an unknown geometry", () => {
    const get = vi.spyOn(apiClient, "get");
    renderHook(
      () =>
        useOsmContributionCategories(
          { ref: REF, geometry: "unknown", locale: "en", query: "cafe" },
          true,
        ),
      { wrapper: wrapper() },
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe("mutations", () => {
  it("previews, publishes and creates a note through the right endpoints", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue(PREVIEW);
    const { result } = renderHook(() => usePreviewOsmContribution(), { wrapper: wrapper() });
    await result.current.mutateAsync({
      ref: REF,
      baseVersion: 4,
      changes: [{ field: "name", action: "set", value: "B" }],
      locale: "en",
      idempotencyKey: UUID,
    });
    expect(post).toHaveBeenCalledWith("/api/osm/contributions/preview", expect.anything());

    post.mockResolvedValue({
      ref: REF,
      version: 5,
      changesetId: 77,
      changesetUrl: "https://www.openstreetmap.org/changeset/77",
      elementUrl: "https://www.openstreetmap.org/node/12",
      publishedAt: "2026-08-10T09:00:00.000Z",
    });
    const publish = renderHook(() => usePublishOsmContribution(), { wrapper: wrapper() });
    const published = await publish.result.current.mutateAsync({
      ref: REF,
      baseVersion: 4,
      changes: [{ field: "name", action: "set", value: "B" }],
      locale: "en",
      idempotencyKey: UUID,
      evidence: { kind: "survey" },
      reviewRequested: false,
      comment: "Corrected the name from the sign",
    });
    expect(published.changesetId).toBe(77);

    post.mockResolvedValue({
      noteId: 9,
      noteUrl: "https://www.openstreetmap.org/note/9",
      status: "open",
    });
    const note = renderHook(() => useCreateOsmNote(), { wrapper: wrapper() });
    const created = await note.result.current.mutateAsync({
      ref: REF,
      text: "The entrance is on the other side.",
      idempotencyKey: UUID,
    });
    expect(created.noteId).toBe(9);
  });

  it("translates a structured error payload into a typed contribution error", async () => {
    vi.spyOn(apiClient, "post").mockRejectedValue(
      new ApiClientError(
        409,
        { code: "VERSION_CONFLICT", message: "Changed.", context: CONTEXT },
        null,
      ),
    );
    const { result } = renderHook(() => usePublishOsmContribution(), { wrapper: wrapper() });
    const error = (await result.current
      .mutateAsync({
        ref: REF,
        baseVersion: 4,
        changes: [{ field: "name", action: "set", value: "B" }],
        locale: "en",
        idempotencyKey: UUID,
        evidence: { kind: "survey" },
        reviewRequested: false,
        comment: "Corrected the name from the sign",
      })
      .catch((e: unknown) => e)) as { code?: string; context?: OsmContributionContext };
    expect(error.code).toBe("VERSION_CONFLICT");
    expect(error.context?.version).toBe(4);
  });

  it("exposes a bounded retry time for a throttled request", async () => {
    vi.spyOn(apiClient, "post").mockRejectedValue(
      new ApiClientError(429, { code: "RATE_LIMITED", message: "Slow down." }, 30),
    );
    const { result } = renderHook(() => usePreviewOsmContribution(), { wrapper: wrapper() });
    const error = (await result.current
      .mutateAsync({
        ref: REF,
        baseVersion: 4,
        changes: [{ field: "name", action: "set", value: "B" }],
        locale: "en",
        idempotencyKey: UUID,
      })
      .catch((e: unknown) => e)) as { code?: string; retryAfterSeconds?: number };
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(30);
  });

  it("returns a generic safe error when the payload does not validate", async () => {
    const leaked = "upstream-detail-should-not-render";
    vi.spyOn(apiClient, "post").mockRejectedValue(
      new ApiClientError(500, { unexpected: leaked }, null),
    );
    const { result } = renderHook(() => usePreviewOsmContribution(), { wrapper: wrapper() });
    const error = (await result.current
      .mutateAsync({
        ref: REF,
        baseVersion: 4,
        changes: [{ field: "name", action: "set", value: "B" }],
        locale: "en",
        idempotencyKey: UUID,
      })
      .catch((e: unknown) => e)) as { code?: string; message?: string };
    expect(error.code).toBe("OSM_UNAVAILABLE");
    expect(JSON.stringify(error)).not.toContain(leaked);
  });

  it("never retries a mutation", async () => {
    const post = vi.spyOn(apiClient, "post").mockRejectedValue(new ApiClientError(500, null, null));
    const { result } = renderHook(() => usePublishOsmContribution(), { wrapper: wrapper() });
    await result.current
      .mutateAsync({
        ref: REF,
        baseVersion: 4,
        changes: [{ field: "name", action: "set", value: "B" }],
        locale: "en",
        idempotencyKey: UUID,
        evidence: { kind: "survey" },
        reviewRequested: false,
        comment: "Corrected the name from the sign",
      })
      .catch(() => undefined);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid success payload instead of handing it to the UI", async () => {
    vi.spyOn(apiClient, "post").mockResolvedValue({ ref: REF, version: -1 });
    const { result } = renderHook(() => usePublishOsmContribution(), { wrapper: wrapper() });
    const error = (await result.current
      .mutateAsync({
        ref: REF,
        baseVersion: 4,
        changes: [{ field: "name", action: "set", value: "B" }],
        locale: "en",
        idempotencyKey: UUID,
        evidence: { kind: "survey" },
        reviewRequested: false,
        comment: "Corrected the name from the sign",
      })
      .catch((e: unknown) => e)) as { code?: string };
    expect(error.code).toBe("UPSTREAM_INVALID");
  });
});
