import { describe, expect, it } from "vitest";
import type { PhotoProvider } from "./contracts/photo-provider";
import type { StreetLevelProvider } from "./contracts/street-level-imagery-provider";
import {
  capturePhotoProviderContributors,
  captureStreetLevelProviderContributors,
} from "./media-attribution";
import { createMockIntegrationContext } from "./testing";

const api = {
  sourceId: "photos",
  name: "Photo API",
  url: "https://provider.test/",
  providerCountry: "DE",
  providerPrivacyUrl: "https://provider.test/privacy",
  licensing: {
    version: 1 as const,
    bindings: [
      {
        scope: "service" as const,
        subject: "API",
        license: { kind: "unknown" as const },
        attribution: {
          placement: "visible" as const,
          surfaces: ["image" as const],
          basis: "provider-terms" as const,
          reviewedAt: "2026-10-14",
          evidenceUrls: ["https://provider.test/terms"],
          reason: "Logo required",
          logo: "mapillary" as const,
        },
      },
    ],
  },
};
const file = {
  url: "https://image.test/photo.jpg",
  source: "photos",
  author: "Actual photographer",
  licensing: {
    version: 1 as const,
    bindings: [
      {
        scope: "imagery" as const,
        subject: "Actual file",
        license: { kind: "spdx" as const, expression: "CC-BY-4.0" },
      },
    ],
  },
};
it("captures API branding before acquisition and retains the actual per-file grant", async () => {
  let complete!: (value: (typeof file)[]) => void;
  const provider: PhotoProvider = {
    id: "photos",
    name: "Photos",
    search: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  };
  const ctx = createMockIntegrationContext();
  ctx.manifest.dataSources = [structuredClone(api)];
  const wrapped = capturePhotoProviderContributors(ctx, provider);
  const pending = wrapped.search({ lat: 51, lng: 6 });
  ctx.manifest.dataSources[0]!.licensing.bindings[0]!.subject = "Changed API";
  complete([file]);
  const [result] = await pending;
  expect(result?.licensing?.bindings.map((binding) => binding.subject)).toEqual([
    "Actual file",
    "API",
  ]);
  expect(
    result?.contributors?.some((receipt) => receipt.publisher?.name === "Actual photographer"),
  ).toBe(true);
  expect(
    result?.contributors?.some(
      (receipt) => receipt.licensing?.bindings[0]?.attribution?.logo === "mapillary",
    ),
  ).toBe(true);
});
it("does not clear unknown/empty captures by borrowing provider or platform data grants", async () => {
  const ctx = createMockIntegrationContext();
  ctx.manifest.dataSources = [structuredClone(api)];
  const provider: PhotoProvider = {
    id: "photos",
    name: "Photos",
    search: async () => [
      { ...file, contributors: [] },
      { ...file, source: "different" },
    ],
  };
  const result = await capturePhotoProviderContributors(ctx, provider).search({ lat: 51, lng: 6 });
  expect(result[0]?.contributors).toEqual([]);
  expect(result[1]?.licensing?.bindings).toEqual(file.licensing.bindings);
});

it("captures the exact street-level API on all image methods before acquisition", async () => {
  const ctx = createMockIntegrationContext();
  ctx.manifest.dataSources = [structuredClone(api)];
  const image = {
    id: "one",
    providerId: "photos",
    coordinates: [6, 51] as [number, number],
    assets: { sd: file.url },
    author: file.author,
    licensing: file.licensing,
  };
  const provider = {
    id: "photos",
    name: "Photos",
    capabilities: () => ({}),
    getLinks: async () => [],
    getImage: async () => image,
    findNearest: async () => image,
    searchImages: async () => [image],
  } as unknown as StreetLevelProvider;
  const wrapped = captureStreetLevelProviderContributors(ctx, provider, "photos");
  for (const result of [
    await wrapped.getImage("one"),
    await wrapped.findNearest([6, 51]),
    ...(await wrapped.searchImages({ point: [6, 51] } as never)),
  ]) {
    expect(result?.contributors?.some((a) => a.publisher?.name === file.author)).toBe(true);
    expect(result?.licensing?.bindings.map((b) => b.scope)).toEqual(["imagery", "service"]);
  }
});

it("keeps already captured service terms when a provider returns retained cached imagery", async () => {
  const ctx = createMockIntegrationContext();
  ctx.manifest.dataSources = [structuredClone(api)];
  const original = {
    ...file,
    licensing: {
      version: 1 as const,
      bindings: [...file.licensing.bindings, ...api.licensing.bindings],
    },
    contributors: [{ sourceId: "photos", name: "Original API", licensing: api.licensing }],
  };
  ctx.manifest.dataSources[0]!.licensing.bindings[0]!.subject = "New API terms";
  const wrapped = capturePhotoProviderContributors(ctx, {
    id: "photos",
    name: "Photos",
    search: async () => [original],
  });
  const [result] = await wrapped.search({ lat: 51, lng: 6 });
  expect(result?.licensing?.bindings.map((b) => b.subject)).toEqual(["Actual file", "API"]);
  expect(result?.contributors).toEqual(original.contributors);
});
