import { describe, expect, it } from "vitest";
import {
  checkProviderHttp,
  findProviderHttpFindings,
  type ProviderHttpExceptions,
  type ProviderHttpRule,
} from "./check-provider-http.ts";

const lines = (source: string, rule: ProviderHttpRule) =>
  findProviderHttpFindings(source, "module.ts")
    .filter((finding) => finding.rule === rule)
    .map((finding) => finding.line);

const NO_EXCEPTIONS: ProviderHttpExceptions = {
  "raw-fetch": {},
  "credentialed-fetch-json": {},
  "null-island": {},
};

describe("raw fetch", () => {
  it("finds global fetch called, passed on or reached through a global object", () => {
    const source = [
      "export async function load(url) {",
      "  const res = await fetch(url);",
      "  const client = createClient({ fetch: globalThis.fetch });",
      "  const impl: typeof fetch = fetch;",
      "  return window.fetch(url);",
      "}",
    ].join("\n");
    expect(lines(source, "raw-fetch")).toEqual([2, 3, 4, 5]);
  });

  it("ignores injected implementations, properties and types", () => {
    const source = [
      "export async function load(ctx, adapter, fetchImpl: typeof fetch) {",
      "  await ctx.http.get('https://a.test');",
      "  await adapter.fetch(bbox);",
      "  await fetchImpl('https://a.test');",
      "  const options = { fetch: fetchImpl };",
      "  interface Adapter { fetch(bbox: unknown): Promise<void> }",
      "}",
      "function inject({ fetch }: { fetch: typeof globalThis.fetch }) { return fetch('x'); }",
    ].join("\n");
    expect(lines(source, "raw-fetch")).toEqual([]);
  });

  it("still finds the global in a sibling scope of a binding named fetch", () => {
    const source = [
      "function inject(fetch: typeof globalThis.fetch) { return fetch('x'); }",
      "export const load = (url) => fetch(url);",
      "export function block(url) {",
      "  { const fetch = createFetch(); fetch(url); }",
      "  for (const fetch of impls) fetch(url);",
      "  return fetch(url);",
      "}",
      "export function hoisted(url) {",
      "  if (url) { var fetch = createFetch(); }",
      "  return fetch(url);",
      "}",
    ].join("\n");
    expect(lines(source, "raw-fetch")).toEqual([2, 6]);
  });
});

describe("credentialed fetchJson", () => {
  it("finds fetchJson in a module that reads a key, token or secret", () => {
    for (const credential of [
      "const key = ctx.config.apiKey;",
      "const token = ctx.config.githubToken;",
      "const key = await ctx.secrets.get('x');",
      "const headers = { 'x-api-key': key };",
      "const headers = { Authorization: 'Bearer ' + key };",
      "url.searchParams.set('appid', key);",
      "const headers = { 'DB-Api-Key': key };",
    ]) {
      const source = [
        'import { fetchJson } from "@openmapx/core";',
        credential,
        "export const load = (url) => fetchJson<unknown>(url);",
      ].join("\n");
      expect(lines(source, "credentialed-fetch-json"), credential).toEqual([3]);
    }
  });

  it("follows a renamed import and the shared weather wrapper", () => {
    const source = [
      'import { fetchJson as getJson } from "@openmapx/core";',
      'import { fetchJsonWithTimeout } from "@openmapx/integration-weather/lib";',
      "const appid = config.appid;",
      "getJson(url);",
      "fetchJsonWithTimeout(url);",
    ].join("\n");
    expect(lines(source, "credentialed-fetch-json")).toEqual([4, 5]);
  });

  it("allows public fetchJson, plain token words and safeFetch with credentials", () => {
    const publicJson = [
      'import { fetchJson } from "@openmapx/core";',
      "const tokens = query.split(' ').map((token) => token.trim());",
      "export const load = (url) => fetchJson(url);",
    ].join("\n");
    const ssrfBoundary = [
      'import { safeFetchJson } from "@openmapx/core/server";',
      "const headers = { Authorization: key };",
      "export const load = (url) => safeFetchJson(url, { headers });",
    ].join("\n");
    expect(lines(publicJson, "credentialed-fetch-json")).toEqual([]);
    expect(lines(ssrfBoundary, "credentialed-fetch-json")).toEqual([]);
  });
});

describe("null island", () => {
  it("finds a coordinate that falls back to zero, also at the end of a chain", () => {
    const source = [
      "const a = { lat: place.lat ?? 0, lng: place.lon ?? 0 };",
      "const b = event?.position?.latitude ?? 0;",
      "const c = call.geo?.longitude ?? stop?.lng ?? 0;",
      "const d = location.coordinates['lat'] ?? 0;",
      "const e = fromLat ?? 0;",
      "const f = point.lat_e7 ?? 0;",
    ].join("\n");
    expect(lines(source, "null-island")).toEqual([1, 1, 2, 3, 4, 5, 6]);
  });

  it("ignores other zero defaults and non-zero coordinate defaults", () => {
    const source = [
      "const a = leg.distance ?? 0;",
      "const b = place.lat ?? fallback.lat;",
      "const c = place.lat ?? 0.5;",
      "const d = (place.lat ?? 1) + 0;",
      "const e = latency ?? 0;",
      "const f = stats.longest ?? 0;",
      "const g = plateau ?? 0;",
    ].join("\n");
    expect(lines(source, "null-island")).toEqual([]);
  });
});

describe("checkProviderHttp", () => {
  const modules = new Map([
    ["integrations/a/index.ts", "export const load = (url) => fetch(url);"],
    ["integrations/b/index.ts", "export const p = { lat: x.lat ?? 0, lng: x.lng ?? 0 };"],
  ]);

  it("refuses findings without an exception and names the file and line", () => {
    const failures = checkProviderHttp(modules, NO_EXCEPTIONS);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("integrations/a/index.ts calls raw fetch");
    expect(failures[0]).toContain("integrations/a/index.ts:1");
    expect(failures[1]).toContain("defaults a coordinate to zero");
  });

  it("accepts an exact exception count and refuses any other", () => {
    const exact: ProviderHttpExceptions = {
      ...NO_EXCEPTIONS,
      "raw-fetch": { "integrations/a/index.ts": { count: 1, reason: "local probe" } },
      "null-island": { "integrations/b/index.ts": { count: 2, reason: "pending" } },
    };
    expect(checkProviderHttp(modules, exact)).toEqual([]);

    const stale: ProviderHttpExceptions = {
      ...exact,
      "null-island": { "integrations/b/index.ts": { count: 3, reason: "pending" } },
    };
    expect(checkProviderHttp(modules, stale)).toEqual([
      expect.stringContaining("holds 2 null-island findings; its exception allows 3"),
    ]);
  });

  it("asks to remove an exception that no longer matches anything", () => {
    const exceptions: ProviderHttpExceptions = {
      ...NO_EXCEPTIONS,
      "raw-fetch": {
        "integrations/a/index.ts": { count: 1, reason: "local probe" },
        "integrations/b/index.ts": { count: 1, reason: "gone" },
        "integrations/missing/index.ts": { count: 1, reason: "deleted" },
      },
      "null-island": { "integrations/b/index.ts": { count: 2, reason: "pending" } },
    };
    expect(checkProviderHttp(modules, exceptions)).toEqual([
      "integrations/b/index.ts has no raw-fetch findings any more; remove its exception.",
      "integrations/missing/index.ts is listed as a raw-fetch exception but is not scanned.",
    ]);
  });
});
