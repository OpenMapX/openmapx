import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Upstream fetch + Google Photos resolution are mocked so the proxy never hits
// the network; the variables are `mock`-prefixed so Vitest's hoisting allows
// them inside the (hoisted) vi.mock factories.
const mockFetchWithRedirects = vi.fn();
const mockResolveGooglePhotosLink = vi.fn();
const mockLookup = vi.fn();

// The proxy's private-address guard resolves each hop's host itself; stubbing
// the resolver decides where a declared host "points".
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));
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
import {
  cameraMediaSourcesOf,
  isAllowedHost,
  isCameraHost,
  isStaticImageHost,
  setCameraMediaSources,
  setGatedImageSourceResolver,
} from "../image-hosts.js";
import { imageProxyRoute, withPublisherHeaders } from "../image-proxy.js";

const CAMERA_SOURCE = "fi-digitraffic-cameras";

function declareCameraHosts(hosts: readonly string[]): void {
  setCameraMediaSources(hosts.length > 0 ? [{ sourceId: CAMERA_SOURCE, mediaHosts: hosts }] : []);
}

const ALLOWED_REFERER = "http://localhost:3000/some/page";
const ALLOWED = "https://upload.wikimedia.org/wikipedia/commons/a/ab/x.png";
const DIGITRAFFIC_STILL = "https://weathercam.digitraffic.fi/C0150301.jpg";
const TFL_HOSTS = ["s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/"];
const TFL_STILL = "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.06514.jpg";
const CAMERA_HOSTS = ["weathercam.digitraffic.fi", "*.thb.gov.tw", ...TFL_HOSTS];

afterEach(() => {
  declareCameraHosts([]);
  setGatedImageSourceResolver(() => new Set());
});

describe("image-proxy static allowlist (SSRF)", () => {
  it.each([
    "upload.wikimedia.org",
    "commons.wikimedia.org",
    "thumb.wikimedia.org",
    "images.mapillary.com",
    "live.staticflickr.com",
    "api.entur.io",
    "tile.openstreetmap.org",
  ])("allows exact allowlisted host %s", (host) => {
    expect(isStaticImageHost(host)).toBe(true);
    expect(isAllowedHost(new URL(`https://${host}/a.jpg`))).toBe(true);
  });

  it.each([
    "scontent-fra5-2.xx.fbcdn.net", // Mapillary regional CDN subdomain
    "sub.upload.wikimedia.org",
    "www.gravatar.com", // OSM avatars served via Gravatar
    "secure.gravatar.com",
    "0.gravatar.com", // Gravatar CDN subdomain
  ])("allows subdomains of an allowlisted host (%s)", (host) => {
    expect(isStaticImageHost(host)).toBe(true);
  });

  it.each([
    // OSM avatar S3 bucket — the redirect target of Active Storage avatar URLs.
    "openstreetmap-user-avatars.s3.dualstack.eu-west-1.amazonaws.com", // observed (dualstack, eu-west-1)
    "openstreetmap-user-avatars.s3.amazonaws.com", // legacy global virtual-host form
    "openstreetmap-user-avatars.s3.eu-west-1.amazonaws.com", // non-dualstack regional form
  ])("allows the OSM avatar S3 bucket (%s)", (host) => {
    expect(isStaticImageHost(host)).toBe(true);
  });

  it.each([
    "upload.wikimedia.org.attacker.com", // suffix-spoof
    "xupload.wikimedia.org", // prefix without a label boundary
    "xthumb.wikimedia.org",
    "anything.thumb.wikimedia.org",
    "thumb.wikimedia.org.attacker.com",
    "wikimedia.org", // parent of an allowlisted subdomain, not itself listed
    "attacker.com",
    "fbcdn.net", // deliberately NOT allowlisted wholesale
    "notlocalhost",
    "",
    "evil.amazonaws.com", // not the OSM avatar bucket — *.amazonaws.com stays closed
    "openstreetmap-user-avatars-evil.s3.amazonaws.com", // different bucket, leftmost label must match exactly
    "openstreetmap-user-avatars.s3.dualstack.eu-west-1.amazonaws.com.attacker.com", // suffix-spoof past .amazonaws.com
    "gravatar.com.attacker.com", // Gravatar suffix-spoof
    // Camera operators are no longer static entries: only a live source's
    // declared media hosts admit them.
    "weathercam.digitraffic.fi",
    "kamera.atlas.vegvesen.no",
    "www.511pa.com",
    "cwwp2.dot.ca.gov",
    "images-webcams.windy.com",
  ])("rejects non-allowlisted / spoofed host %s", (host) => {
    expect(isStaticImageHost(host)).toBe(false);
    expect(isAllowedHost(new URL(`https://${host}/a.jpg`))).toBe(false);
  });
});

describe("image-proxy camera media hosts", () => {
  it("admits a declared camera host only once the live sources declared it", () => {
    const still = new URL(DIGITRAFFIC_STILL);
    expect(isAllowedHost(still)).toBe(false);
    declareCameraHosts(CAMERA_HOSTS);
    expect(isAllowedHost(still)).toBe(true);
    expect(isCameraHost(still)).toBe(true);
    expect(isAllowedHost(new URL("https://cctv1.thb.gov.tw/a.jpg"))).toBe(true);
    declareCameraHosts([]);
    expect(isAllowedHost(still)).toBe(false);
  });

  it("admits only the declared path prefix on a shared host", () => {
    declareCameraHosts(TFL_HOSTS);
    expect(isAllowedHost(new URL(TFL_STILL))).toBe(true);
    expect(
      isAllowedHost(new URL("https://s3-eu-west-1.amazonaws.com/other-bucket/secret.jpg")),
    ).toBe(false);
    expect(isAllowedHost(new URL("https://evil.amazonaws.com/jamcams.tfl.gov.uk/a.jpg"))).toBe(
      false,
    );
  });

  it("keeps place photos on the static list", () => {
    declareCameraHosts(CAMERA_HOSTS);
    expect(isStaticImageHost("weathercam.digitraffic.fi")).toBe(false);
    expect(isStaticImageHost("s3-eu-west-1.amazonaws.com")).toBe(false);
  });

  it("treats a static host as a static host even when a source also declares it", () => {
    declareCameraHosts(["upload.wikimedia.org"]);
    expect(isCameraHost(new URL(ALLOWED))).toBe(false);
  });

  it("collects media hosts from the enabled integrations' live data sources only", () => {
    const sources = cameraMediaSourcesOf([
      {
        enabled: true,
        manifest: {
          dataSources: [
            { sourceId: "fi-digitraffic-cameras", mediaHosts: ["weathercam.digitraffic.fi"] },
            { sourceId: "de-osm-cameras" },
            { sourceId: "gb-tfl-jamcams", mediaHosts: TFL_HOSTS },
            { sourceId: "xx-empty-cameras", mediaHosts: [] },
          ],
        },
      },
      {
        enabled: false,
        manifest: {
          dataSources: [{ sourceId: "xx-off-cameras", mediaHosts: ["cams.example.org"] }],
        },
      },
      { enabled: true, manifest: {} },
    ]);
    expect(sources).toEqual([
      { sourceId: "fi-digitraffic-cameras", mediaHosts: ["weathercam.digitraffic.fi"] },
      { sourceId: "gb-tfl-jamcams", mediaHosts: TFL_HOSTS },
    ]);
  });

  it("refuses a host whose only declaring source the data-use policy disallows", () => {
    setCameraMediaSources([
      { sourceId: CAMERA_SOURCE, mediaHosts: ["weathercam.digitraffic.fi"] },
      { sourceId: "gb-tfl-jamcams", mediaHosts: TFL_HOSTS },
    ]);
    let gated = new Set([CAMERA_SOURCE]);
    setGatedImageSourceResolver(() => gated);
    expect(isAllowedHost(new URL(DIGITRAFFIC_STILL))).toBe(false);
    expect(isCameraHost(new URL(DIGITRAFFIC_STILL))).toBe(false);
    expect(isAllowedHost(new URL(TFL_STILL))).toBe(true);

    // The policy is read per check, so allowing the source again re-admits it.
    gated = new Set();
    expect(isAllowedHost(new URL(DIGITRAFFIC_STILL))).toBe(true);
  });

  it("admits a host another allowed source also declares", () => {
    setCameraMediaSources([
      { sourceId: CAMERA_SOURCE, mediaHosts: ["weathercam.digitraffic.fi"] },
      { sourceId: "fi-other-cameras", mediaHosts: ["weathercam.digitraffic.fi"] },
    ]);
    setGatedImageSourceResolver(() => new Set([CAMERA_SOURCE]));
    expect(isAllowedHost(new URL(DIGITRAFFIC_STILL))).toBe(true);
  });
});

describe("image-proxy publisher identification", () => {
  const headersOf = async (url: string): Promise<Headers> => {
    let sent = new Headers();
    const pinned = withPublisherHeaders(
      async (_input: string | URL, _addresses: unknown[], init) => {
        sent = new Headers(init.headers);
        return new Response(null);
      },
    );
    await pinned(url, [], { headers: { "User-Agent": "test-agent" } });
    return sent;
  };

  it("names the application to Digitraffic, whose image limit rises for identified clients", async () => {
    const sent = await headersOf("https://weathercam.digitraffic.fi/C0150301.jpg");
    expect(sent.get("Digitraffic-User")).toBe("test-agent");
    expect(sent.get("User-Agent")).toBe("test-agent");
  });

  it("sends the Digitraffic header to no other host, including a redirect target", async () => {
    for (const url of [
      "https://cwwp2.dot.ca.gov/data/d7/cctv/image/x.jpg",
      "https://digitraffic.fi.evil.example/a.jpg",
      "https://evildigitraffic.fi/a.jpg",
    ]) {
      const sent = await headersOf(url);
      expect(sent.has("Digitraffic-User"), url).toBe(false);
      expect(sent.get("User-Agent"), url).toBe("test-agent");
    }
  });
});

describe("image-proxy route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.CORS_ORIGIN = "http://localhost:3000";
    mockFetchWithRedirects.mockReset();
    mockResolveGooglePhotosLink.mockReset();
    app = await buildTestApp(imageProxyRoute);
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  const inject = (opts: {
    url?: string;
    referer?: string;
    origin?: string;
    remoteAddress?: string;
  }) => {
    const headers: Record<string, string> = {};
    if (opts.referer) headers.referer = opts.referer;
    if (opts.origin) headers.origin = opts.origin;
    return app.inject({
      method: "GET",
      url: "/image-proxy",
      query: { url: opts.url ?? ALLOWED },
      headers,
      remoteAddress: opts.remoteAddress,
    });
  };

  async function rebuildApp(env: Record<string, string>): Promise<void> {
    await app.close();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    app = await buildTestApp(imageProxyRoute);
  }

  function imageResponse(bytes: number, declaredBytes: number | string = bytes): Response {
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-length": String(declaredBytes),
        "content-type": "image/png",
      },
    });
  }

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
    let cancelled = false;
    mockFetchWithRedirects.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      body: new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      }),
    });
    const res = await inject({ referer: ALLOWED_REFERER });
    expect(res.statusCode).toBe(415);
    expect(cancelled).toBe(true);
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

  it("limits actual image bytes per client and refills the budget", async () => {
    // The token bucket refills continuously: even 20 ms between requests can
    // replenish the missing byte. Keep its clock independent of runner load.
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await rebuildApp({
        RATE_LIMIT_IMAGE_PROXY_MAX_BYTES: "5",
        RATE_LIMIT_IMAGE_PROXY_WINDOW_MS: "100",
      });
      mockFetchWithRedirects.mockImplementation(async () => imageResponse(3));
      const request = { referer: ALLOWED_REFERER, remoteAddress: "198.51.100.20" };

      const first = await inject(request);
      const exhausted = await inject(request);
      clock.mockReturnValue(110);
      const refilled = await inject(request);

      expect(first.statusCode).toBe(200);
      expect(first.rawPayload.byteLength).toBe(3);
      expect(exhausted.statusCode).toBe(429);
      expect(exhausted.headers["cache-control"]).toBe("private, no-store");
      expect(refilled.statusCode).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  it("stops a stream that exceeds both its declared length and the remaining byte budget", async () => {
    await rebuildApp({
      RATE_LIMIT_IMAGE_PROXY_MAX_BYTES: "5",
      RATE_LIMIT_IMAGE_PROXY_WINDOW_MS: "60000",
    });
    mockFetchWithRedirects.mockResolvedValueOnce(imageResponse(6, 3));

    await expect(
      inject({ referer: ALLOWED_REFERER, remoteAddress: "198.51.100.24" }),
    ).rejects.toThrow(/byte budget/i);
  });

  it("charges completed responses by bytes streamed rather than an overstated length", async () => {
    await rebuildApp({
      RATE_LIMIT_IMAGE_PROXY_MAX_BYTES: "5",
      RATE_LIMIT_IMAGE_PROXY_WINDOW_MS: "60000",
    });
    mockFetchWithRedirects
      .mockResolvedValueOnce(imageResponse(2, 5))
      .mockResolvedValueOnce(imageResponse(3, 3));
    const request = { referer: ALLOWED_REFERER, remoteAddress: "198.51.100.25" };

    const overstated = await inject(request);
    const remainingBudget = await inject(request);

    expect(overstated.statusCode).toBe(200);
    expect(overstated.rawPayload.byteLength).toBe(2);
    expect(remainingBudget.statusCode).toBe(200);
    expect(remainingBudget.rawPayload.byteLength).toBe(3);
  });

  it("ignores an invalid Content-Length and enforces limits from streamed bytes", async () => {
    mockFetchWithRedirects.mockResolvedValueOnce(imageResponse(3, "3junk"));

    const response = await inject({ referer: ALLOWED_REFERER });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.byteLength).toBe(3);
    expect(response.headers["content-length"]).toBeUndefined();
  });

  it("caps concurrent streams per client and releases the slot after completion", async () => {
    await rebuildApp({
      RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_PER_CLIENT: "1",
      RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_GLOBAL: "10",
    });
    let finishFirst!: (response: Response) => void;
    const firstUpstream = new Promise<Response>((resolve) => {
      finishFirst = resolve;
    });
    mockFetchWithRedirects.mockReturnValueOnce(firstUpstream);
    const request = { referer: ALLOWED_REFERER, remoteAddress: "198.51.100.21" };
    const first = inject(request);
    await vi.waitFor(() => expect(mockFetchWithRedirects).toHaveBeenCalledTimes(1));

    let overlapping!: Awaited<ReturnType<typeof inject>>;
    try {
      overlapping = await inject(request);
    } finally {
      finishFirst(new Response(null, { status: 404 }));
    }

    expect(overlapping.statusCode).toBe(429);
    expect(await first).toMatchObject({ statusCode: 404 });
    mockFetchWithRedirects.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await inject(request)).statusCode).toBe(404);
  });

  it("caps concurrent streams across different clients", async () => {
    await rebuildApp({
      RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_PER_CLIENT: "10",
      RATE_LIMIT_IMAGE_PROXY_MAX_CONCURRENT_GLOBAL: "1",
    });
    let finishFirst!: (response: Response) => void;
    const firstUpstream = new Promise<Response>((resolve) => {
      finishFirst = resolve;
    });
    mockFetchWithRedirects.mockReturnValueOnce(firstUpstream);
    const first = inject({ referer: ALLOWED_REFERER, remoteAddress: "198.51.100.22" });
    await vi.waitFor(() => expect(mockFetchWithRedirects).toHaveBeenCalledTimes(1));

    let overlapping!: Awaited<ReturnType<typeof inject>>;
    try {
      overlapping = await inject({
        referer: ALLOWED_REFERER,
        remoteAddress: "198.51.100.23",
      });
    } finally {
      finishFirst(new Response(null, { status: 404 }));
    }

    expect(overlapping.statusCode).toBe(429);
    expect(await first).toMatchObject({ statusCode: 404 });
  });

  it("cancels the upstream fetch when the client disconnects", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    let finishUpstream!: (response: Response) => void;
    let upstreamCancelled = false;
    mockFetchWithRedirects.mockImplementation(
      async (_url: string, options: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          finishUpstream = resolve;
          options.signal?.addEventListener(
            "abort",
            () => {
              upstreamCancelled = true;
              reject(options.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    const request = get(
      `http://127.0.0.1:${address.port}/image-proxy?url=${encodeURIComponent(ALLOWED)}`,
      { headers: { referer: ALLOWED_REFERER } },
    );
    request.on("error", () => {});
    await vi.waitFor(() => expect(mockFetchWithRedirects).toHaveBeenCalledOnce());

    try {
      request.destroy();
      await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
    } finally {
      finishUpstream?.(new Response(null, { status: 499 }));
    }
  });

  it("cancels an active upstream body when the client disconnects after streaming starts", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    let upstreamCancelled = false;
    let finishStream: (() => void) | undefined;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        finishStream = () => controller.close();
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    mockFetchWithRedirects.mockResolvedValue(
      new Response(upstreamBody, { headers: { "content-type": "image/png" } }),
    );
    const request = get(
      `http://127.0.0.1:${address.port}/image-proxy?url=${encodeURIComponent(ALLOWED)}`,
      { headers: { referer: ALLOWED_REFERER } },
      (response) => {
        response.once("data", () => response.destroy());
      },
    );
    request.on("error", () => {});

    try {
      await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
    } finally {
      if (!upstreamCancelled) finishStream?.();
      request.destroy();
    }
  });

  it("refuses a camera still before the sources load and serves it uncached after", async () => {
    const before = await inject({ referer: ALLOWED_REFERER, url: DIGITRAFFIC_STILL });
    expect(before.statusCode).toBe(403);
    expect(mockFetchWithRedirects).not.toHaveBeenCalled();

    declareCameraHosts(CAMERA_HOSTS);
    mockFetchWithRedirects.mockResolvedValueOnce(imageResponse(3));
    const after = await inject({ referer: ALLOWED_REFERER, url: DIGITRAFFIC_STILL });
    expect(after.statusCode).toBe(200);
    expect(after.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a camera still whose source the data-use policy disallows", async () => {
    declareCameraHosts(CAMERA_HOSTS);
    setGatedImageSourceResolver(() => new Set([CAMERA_SOURCE]));
    const res = await inject({ referer: ALLOWED_REFERER, url: DIGITRAFFIC_STILL });
    expect(res.statusCode).toBe(403);
    expect(mockFetchWithRedirects).not.toHaveBeenCalled();
  });

  it("keeps the day-long cache for a static host", async () => {
    declareCameraHosts(CAMERA_HOSTS);
    mockFetchWithRedirects.mockResolvedValueOnce(imageResponse(3));
    const res = await inject({ referer: ALLOWED_REFERER });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400, s-maxage=86400");
  });

  it("admits the declared TfL bucket and refuses another bucket on the same host", async () => {
    declareCameraHosts(TFL_HOSTS);
    mockFetchWithRedirects.mockResolvedValueOnce(imageResponse(3));
    const tfl = await inject({ referer: ALLOWED_REFERER, url: TFL_STILL });
    expect(tfl.statusCode).toBe(200);
    expect(tfl.headers["cache-control"]).toBe("no-store");

    const other = await inject({
      referer: ALLOWED_REFERER,
      url: "https://s3-eu-west-1.amazonaws.com/other-bucket/secret.jpg",
    });
    expect(other.statusCode).toBe(403);
    expect(mockFetchWithRedirects).toHaveBeenCalledTimes(1);
  });

  it("re-checks a camera still's redirects against the declared hosts", async () => {
    declareCameraHosts(CAMERA_HOSTS);
    mockFetchWithRedirects.mockResolvedValue({ ok: false, status: 502, headers: new Headers() });
    await inject({ referer: ALLOWED_REFERER, url: TFL_STILL });
    const opts = mockFetchWithRedirects.mock.calls[0]?.[1] as {
      validateRedirectUrl: (url: URL) => boolean;
    };
    expect(
      opts.validateRedirectUrl(
        new URL("https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.jpg"),
      ),
    ).toBe(true);
    expect(opts.validateRedirectUrl(new URL("https://weathercam.digitraffic.fi/a.jpg"))).toBe(true);
    expect(
      opts.validateRedirectUrl(new URL("https://s3-eu-west-1.amazonaws.com/other-bucket/a.jpg")),
    ).toBe(false);
    expect(opts.validateRedirectUrl(new URL("https://cams.undeclared.example/a.jpg"))).toBe(false);
    expect(opts.validateRedirectUrl(new URL("ftp://weathercam.digitraffic.fi/a.jpg"))).toBe(false);
  });

  it("refuses a declared host that resolves to a private address, on every hop", async () => {
    declareCameraHosts(CAMERA_HOSTS);
    // Stand in for fetchWithRedirects' contract: every hop's addresses come
    // from the proxy's resolver before a socket is opened.
    mockFetchWithRedirects.mockImplementation(
      async (url: string, opts: { resolveConnectionAddresses: (u: URL) => Promise<unknown> }) => {
        await opts.resolveConnectionAddresses(new URL(url));
        return imageResponse(3);
      },
    );

    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const privateTarget = await inject({ referer: ALLOWED_REFERER, url: DIGITRAFFIC_STILL });
    expect(privateTarget.statusCode).toBe(502);

    mockLookup.mockResolvedValue([{ address: "::1", family: 6 }]);
    const loopback = await inject({ referer: ALLOWED_REFERER, url: DIGITRAFFIC_STILL });
    expect(loopback.statusCode).toBe(502);

    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const linkLocal = await inject({ referer: ALLOWED_REFERER, url: TFL_STILL });
    expect(linkLocal.statusCode).toBe(502);

    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const publicTarget = await inject({ referer: ALLOWED_REFERER, url: DIGITRAFFIC_STILL });
    expect(publicTarget.statusCode).toBe(200);
    expect(mockLookup).toHaveBeenLastCalledWith("weathercam.digitraffic.fi", expect.anything());
  });

  it("pins every hop's socket to the addresses it checked", async () => {
    mockFetchWithRedirects.mockResolvedValue({ ok: false, status: 404, headers: new Headers() });
    await inject({ referer: ALLOWED_REFERER });
    const opts = mockFetchWithRedirects.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(typeof opts.resolveConnectionAddresses).toBe("function");
    expect(typeof opts.pinnedFetchImplementation).toBe("function");
    expect(typeof opts.releaseResponse).toBe("function");
  });

  it("re-checks redirect targets against the allowlist", async () => {
    mockFetchWithRedirects.mockResolvedValue({ ok: false, status: 502, headers: new Headers() });
    await inject({ referer: ALLOWED_REFERER });
    const opts = mockFetchWithRedirects.mock.calls[0]?.[1] as {
      validateRedirectUrl: (url: URL) => boolean;
    };
    expect(opts.validateRedirectUrl(new URL("https://upload.wikimedia.org/next"))).toBe(true);
    expect(opts.validateRedirectUrl(new URL("https://thumb.wikimedia.org/next"))).toBe(true);
    expect(opts.validateRedirectUrl(new URL("https://anything.thumb.wikimedia.org/next"))).toBe(
      false,
    );
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
