import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Upstream fetch + Google Photos resolution are mocked so the proxy never hits
// the network; the variables are `mock`-prefixed so Vitest's hoisting allows
// them inside the (hoisted) vi.mock factories.
const mockFetchWithRedirects = vi.fn();
const mockResolveGooglePhotosLink = vi.fn();

vi.mock("@openmapx/core", () => ({
  fetchWithRedirects: (...args: unknown[]) => mockFetchWithRedirects(...args),
  USER_AGENT: "test-agent",
}));
vi.mock("@integrations/photos/orchestrator", () => ({
  resolveGooglePhotosLink: (...args: unknown[]) => mockResolveGooglePhotosLink(...args),
}));

import { buildTestApp } from "../../test/app.js";
import { imageProxyRoute, isAllowedHost } from "../image-proxy.js";

const ALLOWED_REFERER = "http://localhost:3000/some/page";
const ALLOWED = "https://upload.wikimedia.org/wikipedia/commons/a/ab/x.png";

describe("image-proxy isAllowedHost (SSRF allowlist)", () => {
  it.each([
    "upload.wikimedia.org",
    "commons.wikimedia.org",
    "images.mapillary.com",
    "live.staticflickr.com",
    "api.entur.io",
    "tile.openstreetmap.org",
  ])("allows exact allowlisted host %s", (host) => {
    expect(isAllowedHost(host)).toBe(true);
  });

  it.each([
    "scontent-fra5-2.xx.fbcdn.net", // Mapillary regional CDN subdomain
    "www.511pa.com",
    "cwwp2.dot.ca.gov",
    "sub.upload.wikimedia.org",
    "www.gravatar.com", // OSM avatars served via Gravatar
    "secure.gravatar.com",
    "0.gravatar.com", // Gravatar CDN subdomain
  ])("allows subdomains of an allowlisted host (%s)", (host) => {
    expect(isAllowedHost(host)).toBe(true);
  });

  it.each([
    // OSM avatar S3 bucket — the redirect target of Active Storage avatar URLs.
    "openstreetmap-user-avatars.s3.dualstack.eu-west-1.amazonaws.com", // observed (dualstack, eu-west-1)
    "openstreetmap-user-avatars.s3.amazonaws.com", // legacy global virtual-host form
    "openstreetmap-user-avatars.s3.eu-west-1.amazonaws.com", // non-dualstack regional form
  ])("allows the OSM avatar S3 bucket (%s)", (host) => {
    expect(isAllowedHost(host)).toBe(true);
  });

  it.each([
    "upload.wikimedia.org.attacker.com", // suffix-spoof
    "xupload.wikimedia.org", // prefix without a label boundary
    "wikimedia.org", // parent of an allowlisted subdomain, not itself listed
    "attacker.com",
    "fbcdn.net", // deliberately NOT allowlisted wholesale
    "notlocalhost",
    "",
    "evil.amazonaws.com", // not the OSM avatar bucket — *.amazonaws.com stays closed
    "openstreetmap-user-avatars-evil.s3.amazonaws.com", // different bucket, leftmost label must match exactly
    "openstreetmap-user-avatars.s3.dualstack.eu-west-1.amazonaws.com.attacker.com", // suffix-spoof past .amazonaws.com
    "gravatar.com.attacker.com", // Gravatar suffix-spoof
  ])("rejects non-allowlisted / spoofed host %s", (host) => {
    expect(isAllowedHost(host)).toBe(false);
  });
});

describe("image-proxy route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.CORS_ORIGIN = "http://localhost:3000";
    vi.clearAllMocks();
    app = await buildTestApp(imageProxyRoute);
  });
  afterEach(async () => {
    await app.close();
  });

  const inject = (opts: { url?: string; referer?: string; origin?: string }) => {
    const headers: Record<string, string> = {};
    if (opts.referer) headers.referer = opts.referer;
    if (opts.origin) headers.origin = opts.origin;
    return app.inject({
      method: "GET",
      url: "/image-proxy",
      query: { url: opts.url ?? ALLOWED },
      headers,
    });
  };

  it("rejects a request with no Referer/Origin (not an open relay)", async () => {
    const res = await inject({});
    expect(res.statusCode).toBe(403);
    expect(mockFetchWithRedirects).not.toHaveBeenCalled();
  });

  it("rejects a Referer whose origin only prefix-matches a frontend origin", async () => {
    const res = await inject({ referer: "http://localhost:3000.attacker.com/x" });
    expect(res.statusCode).toBe(403);
  });

  it("accepts the Origin header when Referer is absent", async () => {
    mockFetchWithRedirects.mockResolvedValue({ ok: false, status: 404, headers: new Headers() });
    const res = await inject({ origin: "http://localhost:3000" });
    // Passed the referer guard and reached upstream (which we stubbed to 404).
    expect(res.statusCode).toBe(404);
  });

  it("rejects a disallowed upstream host with 403", async () => {
    const res = await inject({ referer: ALLOWED_REFERER, url: "https://evil.attacker.com/a.png" });
    expect(res.statusCode).toBe(403);
    expect(mockFetchWithRedirects).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTP(S) protocol with 400", async () => {
    const res = await inject({ referer: ALLOWED_REFERER, url: "ftp://upload.wikimedia.org/a.png" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unparseable URL with 400", async () => {
    const res = await inject({ referer: ALLOWED_REFERER, url: "abcdefghij" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-image content-type with 415", async () => {
    mockFetchWithRedirects.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      body: null,
    });
    const res = await inject({ referer: ALLOWED_REFERER });
    expect(res.statusCode).toBe(415);
  });

  it("rejects an over-large image (by Content-Length) with 413", async () => {
    mockFetchWithRedirects.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png", "content-length": "999999999" }),
      body: null,
    });
    const res = await inject({ referer: ALLOWED_REFERER });
    expect(res.statusCode).toBe(413);
  });

  it("re-checks redirect targets against the allowlist", async () => {
    mockFetchWithRedirects.mockResolvedValue({ ok: false, status: 502, headers: new Headers() });
    await inject({ referer: ALLOWED_REFERER });
    const opts = mockFetchWithRedirects.mock.calls[0]?.[1] as {
      validateRedirectUrl: (u: { hostname: string }) => boolean;
    };
    expect(opts.validateRedirectUrl({ hostname: "upload.wikimedia.org" })).toBe(true);
    expect(opts.validateRedirectUrl({ hostname: "evil.attacker.com" })).toBe(false);
  });
});
