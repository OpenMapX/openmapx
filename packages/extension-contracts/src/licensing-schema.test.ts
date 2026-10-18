import { describe, expect, expectTypeOf, it } from "vitest";
import z from "zod/v4";
import { dataSourceOutputSchema, dataSourceSchema } from "./integration";
import type { AttributionPolicy, LicenseBinding, LicenseDescriptor, Licensing } from "./licensing";
import { parseLicensing } from "./licensing";
import { licensingSchema } from "./licensing-schema";

const descriptors = [
  { kind: "spdx", expression: "MIT OR Apache-2.0", url: "https://spdx.org/licenses/MIT.html" },
  {
    kind: "custom",
    id: "LicenseRef-API",
    namespace: "provider:example",
    name: "API terms",
    version: "v1",
    url: "https://example.test/terms",
  },
  { kind: "unknown", raw: "Review pending", url: "https://example.test/license" },
  { kind: "per-item", raw: "By publisher", url: "https://example.test/items" },
  { kind: "public-domain", name: "Government works", url: "https://example.test/status" },
  { kind: "status", id: "CC-PDM-1.0", url: "https://creativecommons.org/publicdomain/mark/1.0/" },
] as const;
const policy = {
  placement: "visible",
  surfaces: ["map", "content", "image"],
  basis: "provider-terms",
  reviewedAt: "2026-10-18",
  evidenceUrls: ["https://example.test/attribution"],
  reason: "Reviewed provider terms",
  compactText: "© Example",
  logo: "maptiler",
  prominence: "normal",
  includePublisher: true,
} as const;
const receipt = {
  version: 1,
  bindings: descriptors.map((license) => ({
    scope: "data" as const,
    subject: "Published data",
    license,
    notice: "Retain full credit",
    conditions: ["Link the terms"],
    attribution: policy,
  })),
  declarations: [
    { text: "Original publisher declaration", url: "https://example.test/declaration" },
  ],
} as const;
const source = {
  sourceId: "example-data",
  domain: "weather",
  name: "Example data",
  url: "https://example.test/data",
  owner: "Example publisher",
  termsUrl: "https://example.test/terms",
  methodologyUrl: "https://example.test/methodology",
  dataUseClass: "attribution",
  credentialOwner: "instance-operator",
  reviewedAt: "2026-10-18",
  apiHosts: ["api.example.test"],
  mediaHosts: ["cdn.example.test/images/"],
  licensing: receipt,
  attribution: "© Example",
  notes: "Provider context",
  commercialUse: "conditional",
  redistribution: { sourceData: "conditional", derivedData: "yes" },
  usageConditions: ["Retain credit"],
  providerCountry: "DE",
  providerPrivacyUrl: "https://example.test/privacy",
  endUserExposure: "proxied",
  personalData: true,
  cookies: false,
  dpaAvailable: true,
  dpaUrl: "https://example.test/dpa",
} as const;

describe("portable licensing output contract", () => {
  it("preserves all descriptor variants, declarations and reviewed attribution fields", () => {
    expect(licensingSchema.parse(receipt)).toEqual(receipt);
    expect(parseLicensing(receipt)).toEqual(receipt);
  });

  it("retains empty receipts supported outside authoring manifests", () => {
    expect(licensingSchema.parse({ version: 1, bindings: [] })).toEqual({
      version: 1,
      bindings: [],
    });
  });

  it.each([
    { kind: "other" },
    { kind: "spdx" },
    { kind: "custom", id: "LicenseRef-API", name: "Missing namespace" },
    { kind: "status", id: "not-a-public-domain-mark" },
    { kind: "unknown", expression: "MIT" },
  ])("rejects incomplete or invalid descriptor discriminators: %j", (license) => {
    expect(
      licensingSchema.safeParse({
        version: 1,
        bindings: [{ scope: "data", subject: "Data", license }],
      }).success,
    ).toBe(false);
  });

  it("rejects wrong versions, scopes and malformed attribution without stripping them", () => {
    for (const value of [
      { version: 2, bindings: [] },
      { version: 1, bindings: [{ ...receipt.bindings[0], scope: "other" }] },
      {
        version: 1,
        bindings: [{ ...receipt.bindings[0], attribution: { ...policy, logo: "remote-logo" } }],
      },
      {
        version: 1,
        bindings: [{ ...receipt.bindings[0], attribution: { ...policy, includePublisher: false } }],
      },
      { ...receipt, undeclared: true },
    ])
      expect(licensingSchema.safeParse(value).success).toBe(false);
  });

  it("preserves the existing readonly structural types without making properties readonly", () => {
    type ExpectedDescriptor =
      | { kind: "spdx"; expression: string; url?: string }
      | {
          kind: "custom";
          id: string;
          namespace: string;
          name: string;
          url?: string;
          version?: string;
        }
      | { kind: "unknown"; raw?: string; url?: string }
      | { kind: "per-item"; raw?: string; url?: string }
      | { kind: "public-domain"; name: string; url?: string }
      | { kind: "status"; id: "CC-PDM-1.0"; url?: string };
    expectTypeOf<LicenseDescriptor>().toEqualTypeOf<ExpectedDescriptor>();
    expectTypeOf<Licensing>().toEqualTypeOf<{
      version: 1;
      bindings: readonly LicenseBinding[];
      declarations?: readonly { text?: string; url?: string }[];
    }>();
    expectTypeOf<AttributionPolicy["surfaces"]>().toEqualTypeOf<
      readonly ("map" | "content" | "image")[]
    >();
    expectTypeOf<LicenseBinding["conditions"]>().toEqualTypeOf<readonly string[] | undefined>();
    const mutableProperty: Licensing = { version: 1, bindings: [] };
    mutableProperty.bindings = receipt.bindings;
    expect(mutableProperty.bindings).toHaveLength(6);
  });
});

describe("source output contract", () => {
  it("preserves every source metadata field with complete structured licensing", () => {
    expect(dataSourceOutputSchema.parse(source)).toEqual(source);
  });

  it("keeps semantic expression normalization in the authoring parser", () => {
    const input = {
      ...source,
      licensing: {
        version: 1,
        bindings: [
          { scope: "data", subject: "Data", license: { kind: "spdx", expression: "mit" } },
        ],
      },
    };
    expect(dataSourceSchema.parse(input).licensing.bindings[0]?.license).toEqual({
      kind: "spdx",
      expression: "MIT",
    });
    expect(dataSourceOutputSchema.parse(input).licensing.bindings[0]?.license).toEqual({
      kind: "spdx",
      expression: "mit",
    });
  });

  it("emits complete JSON Schema without weakening licensing to unknown JSON", () => {
    const schema = z.toJSONSchema(dataSourceOutputSchema, { io: "output", target: "draft-7" });
    const licensing = schema.properties?.licensing;
    expect(licensing).toMatchObject({
      type: "object",
      required: ["version", "bindings"],
      additionalProperties: false,
    });
    expect(JSON.stringify(licensing)).toContain('"includePublisher"');
    expect(JSON.stringify(licensing)).toContain('"public-domain"');
    expect(JSON.stringify(licensing)).toContain('"namespace"');
    expect(() => z.toJSONSchema(licensingSchema, { io: "output" })).not.toThrow();
  });
});
