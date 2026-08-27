import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
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
vi.mock("@integrations/photos/orchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@integrations/photos/orchestrator")>()),
  resolveGooglePhotosLink: (...args: unknown[]) => mockResolveGooglePhotosLink(...args),
}));

import {
  controlledRequestLoggingOptions,
  registerControlledRequestLogging,
} from "../../server-wiring.js";
import { buildTestApp } from "../../test/app.js";
import { createSafePinoOptions } from "../../utils/safe-log-fields.js";
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
    "weathercam.digitraffic.fi",
    "api.trafikinfo.trafikverket.se",
    "kamera.atlas.vegvesen.no",
    "www.vegagerdin.is",
    "etraffic.dgt.es",
    "511on.ca",
    "tdcctv.data.one.gov.hk",
    "webcams.transport.nsw.gov.au",
    "cctvn01.freeway.gov.tw",
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
      validateRedirectUrl: (url: URL) => boolean;
    };
    expect(opts.validateRedirectUrl(new URL("https://upload.wikimedia.org/next"))).toBe(true);
    expect(opts.validateRedirectUrl(new URL("https://evil.attacker.com/next"))).toBe(false);
  });

  it.each([
    "https://evil.attacker.com/stolen.png",
    "http://lh3.googleusercontent.com/downgraded.png",
    "https://photos.google.com/share/not-an-image",
  ])("rejects an unsafe Google Photos resolution before fetching %s", async (resolved) => {
    mockResolveGooglePhotosLink.mockResolvedValue([resolved]);

    const res = await inject({
      referer: ALLOWED_REFERER,
      url: "https://photos.app.goo.gl/valid-share-id",
    });

    expect(res.statusCode).toBe(403);
    expect(mockFetchWithRedirects).not.toHaveBeenCalled();
  });

  it("keeps every redirect from a resolved Google image on HTTPS Google image hosts", async () => {
    mockResolveGooglePhotosLink.mockResolvedValue([
      "https://lh3.googleusercontent.com/long-enough-image-id=w1200",
    ]);
    mockFetchWithRedirects.mockResolvedValue({ ok: false, status: 404, headers: new Headers() });

    await inject({
      referer: ALLOWED_REFERER,
      url: "https://photos.app.goo.gl/valid-share-id",
    });

    const opts = mockFetchWithRedirects.mock.calls[0]?.[1] as {
      validateRedirectUrl: (url: URL) => boolean;
    };
    expect(opts.validateRedirectUrl(new URL("https://lh4.googleusercontent.com/next"))).toBe(true);
    expect(opts.validateRedirectUrl(new URL("http://lh4.googleusercontent.com/next"))).toBe(false);
    expect(opts.validateRedirectUrl(new URL("https://photos.google.com/share/next"))).toBe(false);
    expect(opts.validateRedirectUrl(new URL("https://evil.attacker.com/next"))).toBe(false);
  });

  it("logs only a branded host/digest summary and safe error class for a failed source", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const logger = pino(createSafePinoOptions("info"), stream);
    const secureApp = Fastify(controlledRequestLoggingOptions(logger));
    registerControlledRequestLogging(secureApp, { now: () => 1 });
    await secureApp.register(imageProxyRoute);
    await secureApp.ready();
    const privateUrl =
      "https://fixture-user:fixture-pass@upload.wikimedia.org/sensitive/path/share-id?token=fixture-token#fixture-fragment";
    mockFetchWithRedirects.mockRejectedValue(
      new TypeError(`fetch failed at ${privateUrl} with Bearer fixture-bearer-token`),
    );

    const response = await secureApp.inject({
      method: "GET",
      url: "/image-proxy",
      query: { url: privateUrl },
      headers: { referer: ALLOWED_REFERER },
    });
    await secureApp.close();

    expect(response.statusCode).toBe(502);
    const records = chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const warning = records.find((record) => record.msg === "Image proxy fetch failed");
    expect(warning).toMatchObject({
      imageSource: {
        host: "upload.wikimedia.org",
        digest: "dd51043a63efd542821788b7e5906437",
      },
      errorClass: "TypeError",
    });
    const output = chunks.join("");
    for (const marker of [
      "fixture-user",
      "fixture-pass",
      "sensitive/path",
      "share-id",
      "fixture-token",
      "fixture-fragment",
      "fixture-bearer-token",
    ]) {
      expect(output).not.toContain(marker);
    }
  });
});
