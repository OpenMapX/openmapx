import { describe, expect, it } from "vitest";
import { API_ENDPOINTS } from "../api/endpoints";
import {
  countCodePoints,
  osmCategorySuggestionSchema,
  osmContributionCapabilitiesSchema,
  osmContributionContextSchema,
  osmContributionErrorBodySchema,
  osmContributionErrorCodeSchema,
  osmContributionPreviewRequestSchema,
  osmContributionPreviewSchema,
  osmContributionPublishRequestSchema,
  osmContributionPublishResultSchema,
  osmElementRefSchema,
  osmEvidenceSchema,
  osmFieldChangeSchema,
  osmNoteRequestSchema,
  osmNoteResultSchema,
  parseOsmElementId,
} from "../schemas/osmContribution";

const UUID = "3f4b2a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
/** Astral plane: UTF-16 `.length` is twice the code-point count. */
const ASTRAL = "😀";

function previewRequest(overrides: Record<string, unknown> = {}) {
  return {
    ref: { type: "node", id: 12345 },
    baseVersion: 3,
    changes: [{ field: "name", action: "set", value: "Café Central" }],
    locale: "en",
    idempotencyKey: UUID,
    ...overrides,
  };
}

function publishRequest(overrides: Record<string, unknown> = {}) {
  return {
    ...previewRequest(),
    evidence: { kind: "survey" },
    reviewRequested: false,
    comment: "Corrected the name from the sign on the door",
    ...overrides,
  };
}

describe("countCodePoints", () => {
  it("counts Unicode code points, not UTF-16 code units", () => {
    expect(ASTRAL.length).toBe(2);
    expect(countCodePoints(ASTRAL)).toBe(1);
    expect(countCodePoints(ASTRAL.repeat(255))).toBe(255);
  });
});

describe("osmElementRefSchema", () => {
  it("accepts node, way and relation with positive ids", () => {
    for (const type of ["node", "way", "relation"] as const) {
      expect(osmElementRefSchema.parse({ type, id: 1 })).toEqual({ type, id: 1 });
    }
  });

  it("coerces a numeric string id", () => {
    expect(osmElementRefSchema.parse({ type: "node", id: "42" })).toEqual({
      type: "node",
      id: 42,
    });
  });

  it("rejects zero, negative, fractional and unsafe ids", () => {
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
      expect(osmElementRefSchema.safeParse({ type: "node", id }).success).toBe(false);
    }
  });

  it("rejects unknown element types and extra keys", () => {
    expect(osmElementRefSchema.safeParse({ type: "changeset", id: 1 }).success).toBe(false);
    expect(osmElementRefSchema.safeParse({ type: "node", id: 1, tags: { a: "b" } }).success).toBe(
      false,
    );
  });
});

describe("osmEvidenceSchema", () => {
  it("accepts the closed evidence kinds", () => {
    for (const kind of ["survey", "signage", "officialWebsite"] as const) {
      expect(osmEvidenceSchema.parse({ kind })).toEqual({ kind });
    }
    expect(osmEvidenceSchema.parse({ kind: "otherCompatible", detail: "City open data" })).toEqual({
      kind: "otherCompatible",
      detail: "City open data",
    });
  });

  it("rejects an unknown kind, a detail on a simple kind and a missing detail", () => {
    expect(osmEvidenceSchema.safeParse({ kind: "googleMaps" }).success).toBe(false);
    expect(osmEvidenceSchema.safeParse({ kind: "survey", detail: "x" }).success).toBe(false);
    expect(osmEvidenceSchema.safeParse({ kind: "otherCompatible" }).success).toBe(false);
  });

  it("bounds the compatible-source detail to 3-120 code points without control characters", () => {
    expect(osmEvidenceSchema.safeParse({ kind: "otherCompatible", detail: "ab" }).success).toBe(
      false,
    );
    expect(
      osmEvidenceSchema.safeParse({ kind: "otherCompatible", detail: ASTRAL.repeat(120) }).success,
    ).toBe(true);
    expect(
      osmEvidenceSchema.safeParse({ kind: "otherCompatible", detail: ASTRAL.repeat(121) }).success,
    ).toBe(false);
    expect(
      osmEvidenceSchema.safeParse({ kind: "otherCompatible", detail: "open\u0007data" }).success,
    ).toBe(false);
  });
});

describe("osmFieldChangeSchema", () => {
  it("accepts every scalar set and remove operation", () => {
    for (const field of ["name", "openingHours", "phone", "email", "website", "wheelchair"]) {
      expect(osmFieldChangeSchema.safeParse({ field, action: "set", value: "x" }).success).toBe(
        true,
      );
      expect(osmFieldChangeSchema.safeParse({ field, action: "remove" }).success).toBe(true);
    }
  });

  it("accepts a category set by preset id and an address patch", () => {
    expect(
      osmFieldChangeSchema.safeParse({
        field: "category",
        action: "set",
        presetId: "amenity/cafe",
      }).success,
    ).toBe(true);
    expect(
      osmFieldChangeSchema.safeParse({
        field: "address",
        action: "patch",
        value: {
          houseNumber: { action: "set", value: "12a" },
          postcode: { action: "remove" },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects removing the category and patching a scalar", () => {
    expect(osmFieldChangeSchema.safeParse({ field: "category", action: "remove" }).success).toBe(
      false,
    );
    expect(
      osmFieldChangeSchema.safeParse({ field: "name", action: "patch", value: {} }).success,
    ).toBe(false);
  });

  it("rejects raw tags, unknown fields and unknown address keys", () => {
    expect(
      osmFieldChangeSchema.safeParse({ field: "name", action: "set", value: "x", tags: {} })
        .success,
    ).toBe(false);
    expect(
      osmFieldChangeSchema.safeParse({ field: "amenity", action: "set", value: "cafe" }).success,
    ).toBe(false);
    expect(
      osmFieldChangeSchema.safeParse({
        field: "address",
        action: "patch",
        value: { housenumber: { action: "set", value: "1" } },
      }).success,
    ).toBe(false);
  });

  it("requires at least one address key and rejects an empty patch", () => {
    expect(
      osmFieldChangeSchema.safeParse({ field: "address", action: "patch", value: {} }).success,
    ).toBe(false);
  });

  it("rejects an empty, control-charactered or overlong scalar value", () => {
    expect(
      osmFieldChangeSchema.safeParse({ field: "name", action: "set", value: "" }).success,
    ).toBe(false);
    expect(
      osmFieldChangeSchema.safeParse({ field: "name", action: "set", value: "  " }).success,
    ).toBe(false);
    expect(
      osmFieldChangeSchema.safeParse({ field: "name", action: "set", value: "a\u0000b" }).success,
    ).toBe(false);
    expect(
      osmFieldChangeSchema.safeParse({ field: "name", action: "set", value: ASTRAL.repeat(255) })
        .success,
    ).toBe(true);
    expect(
      osmFieldChangeSchema.safeParse({ field: "name", action: "set", value: ASTRAL.repeat(256) })
        .success,
    ).toBe(false);
  });
});

describe("osmContributionPreviewRequestSchema", () => {
  it("accepts a minimal valid request", () => {
    expect(osmContributionPreviewRequestSchema.safeParse(previewRequest()).success).toBe(true);
  });

  it("rejects an empty change list and more than eight changes", () => {
    expect(
      osmContributionPreviewRequestSchema.safeParse(previewRequest({ changes: [] })).success,
    ).toBe(false);
    const nine = Array.from({ length: 9 }, () => ({ field: "name", action: "set", value: "x" }));
    expect(
      osmContributionPreviewRequestSchema.safeParse(previewRequest({ changes: nine })).success,
    ).toBe(false);
  });

  it("rejects duplicate field discriminants", () => {
    const result = osmContributionPreviewRequestSchema.safeParse(
      previewRequest({
        changes: [
          { field: "name", action: "set", value: "A" },
          { field: "name", action: "remove" },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a bad UUID, an unknown locale and extra keys", () => {
    expect(
      osmContributionPreviewRequestSchema.safeParse(previewRequest({ idempotencyKey: "nope" }))
        .success,
    ).toBe(false);
    expect(
      osmContributionPreviewRequestSchema.safeParse(previewRequest({ locale: "fr" })).success,
    ).toBe(false);
    expect(
      osmContributionPreviewRequestSchema.safeParse(previewRequest({ tags: { amenity: "cafe" } }))
        .success,
    ).toBe(false);
  });

  it("rejects a non-positive base version", () => {
    expect(
      osmContributionPreviewRequestSchema.safeParse(previewRequest({ baseVersion: 0 })).success,
    ).toBe(false);
  });
});

describe("osmContributionPublishRequestSchema", () => {
  it("accepts a complete publish request", () => {
    expect(osmContributionPublishRequestSchema.safeParse(publishRequest()).success).toBe(true);
  });

  it("requires evidence, review flag and comment", () => {
    for (const key of ["evidence", "reviewRequested", "comment"]) {
      const body = publishRequest();
      delete (body as Record<string, unknown>)[key];
      expect(osmContributionPublishRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("bounds the comment at 10-255 code points after trimming", () => {
    expect(
      osmContributionPublishRequestSchema.safeParse(publishRequest({ comment: "too short" }))
        .success,
    ).toBe(false);
    expect(
      osmContributionPublishRequestSchema.safeParse(publishRequest({ comment: "   " })).success,
    ).toBe(false);
    expect(
      osmContributionPublishRequestSchema.safeParse(
        publishRequest({ comment: `  ${ASTRAL.repeat(255)}  ` }),
      ).success,
    ).toBe(true);
    expect(
      osmContributionPublishRequestSchema.safeParse(publishRequest({ comment: ASTRAL.repeat(256) }))
        .success,
    ).toBe(false);
  });

  it("rejects control characters in the comment", () => {
    expect(
      osmContributionPublishRequestSchema.safeParse(
        publishRequest({ comment: "Fixed the name\u0000 from signage" }),
      ).success,
    ).toBe(false);
    expect(
      osmContributionPublishRequestSchema.safeParse(
        publishRequest({ comment: "Fixed the name\nfrom signage" }),
      ).success,
    ).toBe(false);
  });

  it("rejects an invalid evidence discriminant", () => {
    expect(
      osmContributionPublishRequestSchema.safeParse(publishRequest({ evidence: { kind: "guess" } }))
        .success,
    ).toBe(false);
  });
});

describe("osmNoteRequestSchema", () => {
  it("accepts a human note without version or coordinates", () => {
    expect(
      osmNoteRequestSchema.safeParse({
        ref: { type: "way", id: 7 },
        text: "The entrance is on the other side of the building.",
        idempotencyKey: UUID,
      }).success,
    ).toBe(true);
  });

  it("rejects client coordinates, a version and a raw tag map", () => {
    for (const extra of [{ lat: 1, lon: 2 }, { baseVersion: 2 }, { tags: {} }]) {
      expect(
        osmNoteRequestSchema.safeParse({
          ref: { type: "way", id: 7 },
          text: "The entrance is on the other side.",
          idempotencyKey: UUID,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("bounds note text at 10-1000 code points and rejects control characters", () => {
    const base = { ref: { type: "node", id: 1 }, idempotencyKey: UUID };
    expect(osmNoteRequestSchema.safeParse({ ...base, text: "too short" }).success).toBe(false);
    expect(osmNoteRequestSchema.safeParse({ ...base, text: ASTRAL.repeat(1000) }).success).toBe(
      true,
    );
    expect(osmNoteRequestSchema.safeParse({ ...base, text: ASTRAL.repeat(1001) }).success).toBe(
      false,
    );
    expect(osmNoteRequestSchema.safeParse({ ...base, text: "bad\u0007control text" }).success).toBe(
      false,
    );
  });
});

describe("response schemas", () => {
  const context = {
    ref: { type: "node", id: 1 },
    version: 4,
    geometry: "point",
    changesetId: 99,
    center: { lat: 52.5, lon: 13.4 },
    displayName: "Café Central",
    currentPreset: { status: "matched", presetId: "amenity/cafe", name: "Cafe" },
    fields: [
      {
        kind: "text",
        field: "name",
        label: "Name",
        currentValue: "Café Central",
        enabled: true,
        maxCodePoints: 255,
      },
      {
        kind: "choice",
        field: "wheelchair",
        label: "Wheelchair access",
        currentValue: null,
        options: [{ value: "yes", label: "Yes" }],
        enabled: true,
      },
      {
        kind: "address",
        field: "address",
        label: "Address",
        entries: [{ key: "street", label: "Street", currentValue: "Hauptstr." }],
        enabled: true,
      },
      {
        kind: "category",
        field: "category",
        label: "Category",
        currentPresetId: "amenity/cafe",
        currentPresetName: "Cafe",
        enabled: false,
        disabledReason: "CATEGORY_AMBIGUOUS",
      },
    ],
    advancedEditorUrl: "https://www.openstreetmap.org/edit?editor=id&node=1",
    elementUrl: "https://www.openstreetmap.org/node/1",
    fetchedAt: "2026-08-10T09:00:00.000Z",
  };

  it("parses a full contribution context", () => {
    expect(osmContributionContextSchema.safeParse(context).success).toBe(true);
  });

  it("rejects a context carrying a raw tag map", () => {
    expect(
      osmContributionContextSchema.safeParse({ ...context, tags: { amenity: "cafe" } }).success,
    ).toBe(false);
  });

  it("parses capabilities with only known scope literals", () => {
    const capabilities = {
      enabled: true,
      directEditingEnabled: false,
      linked: true,
      canWriteApi: false,
      canWriteNotes: true,
      contributorTermsAgreed: true,
      activeBlock: false,
      account: {
        id: 5,
        displayName: "mapper",
        profileUrl: "https://www.openstreetmap.org/user/mapper",
      },
      requiredScopes: ["write_api"],
      actions: { reauthorize: true },
    };
    expect(osmContributionCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(
      osmContributionCapabilitiesSchema.safeParse({
        ...capabilities,
        requiredScopes: ["write_everything"],
      }).success,
    ).toBe(false);
    expect(
      osmContributionCapabilitiesSchema.safeParse({ ...capabilities, accessToken: "t" }).success,
    ).toBe(false);
  });

  it("parses a preview with semantic and exact tag diffs", () => {
    const preview = {
      ref: { type: "node", id: 1 },
      baseVersion: 4,
      changes: [
        { field: "name", label: "Name", action: "set", before: "Old", after: "New" },
        { field: "phone", label: "Phone", action: "remove", before: "+49 1", after: null },
      ],
      tagDiff: {
        add: [{ key: "wheelchair", value: "yes" }],
        replace: [{ key: "name", from: "Old", to: "New" }],
        remove: [{ key: "phone", value: "+49 1" }],
      },
      warnings: ["VALUE_REMOVED"],
      requiresReview: false,
    };
    expect(osmContributionPreviewSchema.safeParse(preview).success).toBe(true);
    expect(
      osmContributionPreviewSchema.safeParse({ ...preview, warnings: ["SOMETHING"] }).success,
    ).toBe(false);
  });

  it("parses publish, note and category-suggestion results", () => {
    expect(
      osmContributionPublishResultSchema.safeParse({
        ref: { type: "node", id: 1 },
        version: 5,
        changesetId: 42,
        changesetUrl: "https://www.openstreetmap.org/changeset/42",
        elementUrl: "https://www.openstreetmap.org/node/1",
        publishedAt: "2026-08-10T09:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      osmNoteResultSchema.safeParse({
        noteId: 7,
        noteUrl: "https://www.openstreetmap.org/note/7",
        status: "open",
      }).success,
    ).toBe(true);
    expect(
      osmCategorySuggestionSchema.safeParse({
        presetId: "amenity/cafe",
        name: "Cafe",
        iconKey: "maki-cafe",
        geometry: ["point", "area"],
      }).success,
    ).toBe(true);
  });

  it("keeps the error code list closed and the body bounded", () => {
    expect(osmContributionErrorCodeSchema.options).toContain("AMBIGUOUS_RESULT");
    expect(osmContributionErrorCodeSchema.safeParse("SOMETHING_ELSE").success).toBe(false);
    expect(
      osmContributionErrorBodySchema.safeParse({
        code: "RATE_LIMITED",
        message: "Too many requests.",
        retryAfterSeconds: 30,
      }).success,
    ).toBe(true);
    expect(
      osmContributionErrorBodySchema.safeParse({
        code: "VERSION_CONFLICT",
        message: "The element changed.",
        context,
      }).success,
    ).toBe(true);
    expect(
      osmContributionErrorBodySchema.safeParse({
        code: "OSM_UNAVAILABLE",
        message: "Unavailable.",
        upstreamBody: "<html/>",
      }).success,
    ).toBe(false);
  });
});

describe("parseOsmElementId", () => {
  it("accepts the canonical Place.ids.osm forms", () => {
    expect(parseOsmElementId("node/12345")).toEqual({ type: "node", id: 12345 });
    expect(parseOsmElementId("way/1")).toEqual({ type: "way", id: 1 });
    expect(parseOsmElementId("relation/62422")).toEqual({ type: "relation", id: 62422 });
  });

  it("rejects URLs, query strings, prefixes, zero and non-canonical ids", () => {
    for (const value of [
      "https://www.openstreetmap.org/node/1",
      "osm:node/1",
      "node/1?x=1",
      "node/0",
      "node/-1",
      "node/01",
      "node/1.5",
      "node/",
      "node",
      "changeset/1",
      "node/1/2",
      " node/1",
      "NODE/1",
      `node/${Number.MAX_SAFE_INTEGER}0`,
      "",
    ]) {
      expect(parseOsmElementId(value)).toBeNull();
    }
  });
});

describe("API_ENDPOINTS", () => {
  it("exposes the six contribution paths", () => {
    expect(API_ENDPOINTS.osmContributionCapabilities).toBe("/api/osm/contributions/capabilities");
    expect(API_ENDPOINTS.osmContributions).toBe("/api/osm/contributions");
    expect(API_ENDPOINTS.osmContributionCategories).toBe("/api/osm/contributions/categories");
    expect(API_ENDPOINTS.osmContributionPreview).toBe("/api/osm/contributions/preview");
    expect(API_ENDPOINTS.osmContributionPublish).toBe("/api/osm/contributions/publish");
    expect(API_ENDPOINTS.osmContributionNotes).toBe("/api/osm/contributions/notes");
  });
});
