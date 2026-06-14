import { describe, expect, it } from "vitest";
import {
  extractHosts,
  isInternalHost,
  proxyAllows,
  registrable,
  stripComments,
} from "./check-data-flows.ts";

// Pure helpers from the data-flow disclosure gate. These are the load-bearing
// primitives the gate composes to decide whether a contacted host is already
// disclosed (eTLD+1 match), is own-infra/test noise to ignore, or leaks media
// directly to the browser. Testing them protects the protector: the gate is the
// only thing keeping undisclosed third-party data flows out of /privacy + /terms.

describe("registrable (host → eTLD+1)", () => {
  it.each([
    // [host, expected registrable domain]
    ["example.com", "example.com"],
    ["api.example.com", "example.com"],
    ["a.b.c.example.com", "example.com"],
    // Multi-label public suffixes resolve to the registrable label, not last-2.
    ["a.b.example.co.uk", "example.co.uk"],
    ["example.co.uk", "example.co.uk"],
    ["service.gov.uk", "service.gov.uk"],
    ["foo.bar.com.au", "bar.com.au"],
    ["shop.example.co.jp", "example.co.jp"],
    // Unknown multi-label TLD falls back to the last two labels.
    ["a.b.example.unknownsuffix", "example.unknownsuffix"],
    // Case-insensitive + trailing-dot (FQDN) normalization.
    ["API.Example.COM", "example.com"],
    ["api.example.com.", "example.com"],
    // Two-label hosts pass through unchanged.
    ["entur.io", "entur.io"],
    ["api.entur.io", "entur.io"],
  ])("normalizes %s → %s", (host, expected) => {
    expect(registrable(host)).toBe(expected);
  });
});

describe("isInternalHost (own-infra / test noise filter)", () => {
  it.each([
    // Single-label docker service names have no dot → internal.
    ["app-api", true],
    ["nominatim", true],
    ["localhost", true],
    // IPv4 literals are non-routable noise.
    ["127.0.0.1", true],
    ["10.0.0.5", true],
    // Reserved/test TLDs.
    ["foo.test", true],
    ["foo.example", true],
    ["thing.invalid", true],
    ["host.local", true],
    ["svc.internal", true],
    ["example.com", true],
    // Real external hosts are NOT internal.
    ["api.example.org", false],
    ["overpass-api.de", false],
    ["entur.io", false],
    ["example.co.uk", false],
  ])("classifies %s → internal=%s", (host, expected) => {
    expect(isInternalHost(host)).toBe(expected);
  });
});

describe("stripComments (drop provenance URLs in comments)", () => {
  it("removes block comments wholesale", () => {
    const src = "before /* https://leak.example.com/dataset */ after";
    expect(stripComments(src)).not.toContain("leak.example.com");
  });

  it("removes line comments", () => {
    const src = "const x = 1; // see https://leak.example.com/notes\nconst y = 2;";
    const out = stripComments(src);
    expect(out).not.toContain("leak.example.com");
    expect(out).toContain("const y = 2;");
  });

  it("preserves real URLs in string literals (// is part of ://)", () => {
    const src = 'const url = "https://real.example.com/api";';
    expect(stripComments(src)).toContain("real.example.com");
  });
});

describe("extractHosts (runtime hosts a file contacts)", () => {
  it("extracts http(s) hosts from string literals", () => {
    const hosts = extractHosts(
      'fetch("https://api.example.com/x"); get("http://data.example.org/y")',
    );
    expect([...hosts].sort()).toEqual(["api.example.com", "data.example.org"]);
  });

  it("ignores hosts that appear only inside comments", () => {
    const src = '// https://commented.example.com\nfetch("https://live.example.com/x")';
    const hosts = extractHosts(src);
    expect([...hosts]).toEqual(["live.example.com"]);
  });

  it("skips template-interpolated host prefixes", () => {
    // A deep-link URL builder like `https://www.x.${country}.com` captures a
    // truncated "www.x" followed by `.$` — the script's guard must drop it.
    const interpolated = `https://www.x.\${country}.com/path`;
    const hosts = extractHosts(interpolated);
    expect(hosts.size).toBe(0);
  });

  it("filters out internal / docker-service hosts", () => {
    const hosts = extractHosts('fetch("http://app-api/x"); fetch("https://localhost/y")');
    expect(hosts.size).toBe(0);
  });

  it("lowercases extracted hosts", () => {
    const hosts = extractHosts('fetch("https://API.Example.COM/x")');
    expect([...hosts]).toEqual(["api.example.com"]);
  });
});

describe("proxyAllows (image-proxy allowlist host/subdomain match)", () => {
  const allow = new Set(["staticflickr.com", "wikimedia.org"]);

  it.each([
    // [host, allowed?]
    ["staticflickr.com", true],
    ["c.staticflickr.com", true],
    ["upload.wikimedia.org", true],
    // Not a subdomain — a suffix collision must not match.
    ["evilstaticflickr.com", false],
    ["staticflickr.com.evil.com", false],
    ["unrelated.example.com", false],
  ])("host %s allowed=%s", (host, expected) => {
    expect(proxyAllows(host, allow)).toBe(expected);
  });

  it("is case-insensitive on the host", () => {
    expect(proxyAllows("C.StaticFlickr.COM", allow)).toBe(true);
  });
});

// The gate's core disclosure decision composed from the exported primitives:
// a contacted host is "disclosed" iff its registrable domain matches a declared
// or allowlisted registrable domain. This mirrors the inline diff in main().
describe("declared-source / allowlist matching (composed)", () => {
  const ALLOWED = new Set(["openstreetmap.org", "github.com"]);

  function isUndisclosed(
    contactedHost: string,
    declared: Set<string>,
    allowed: Set<string>,
  ): boolean {
    if (isInternalHost(contactedHost)) return false;
    const dom = registrable(contactedHost);
    if (declared.has(dom)) return false;
    if (allowed.has(dom)) return false;
    return true;
  }

  it.each([
    // [contacted, declared-registrable-domains, allowed-domains, undisclosed?]
    ["api.example.com", ["example.com"], [], false], // sibling host of declared eTLD+1
    ["example.com", ["example.com"], [], false], // exact declared
    ["tiles.openstreetmap.org", [], ["openstreetmap.org"], false], // built-in allowlist
    ["a.b.example.co.uk", ["example.co.uk"], [], false], // multi-suffix eTLD+1 match
    ["evil.tracker.net", ["example.com"], ["github.com"], true], // truly undisclosed
    ["app-api", [], [], false], // internal infra, never disclosable
  ])("%s vs declared=%j allowed=%j → undisclosed=%s", (contacted, declared, allowed, expected) => {
    expect(
      isUndisclosed(
        contacted as string,
        new Set(declared as string[]),
        new Set(allowed as string[]),
      ),
    ).toBe(expected);
  });

  it("matches a declared apiHost sibling by registrable domain", () => {
    // Mirrors entur: sources declare developer.entur.org but code hits api.entur.io.
    // The gate only matches by eTLD+1, so api.entur.io is NOT covered by entur.org —
    // it is covered instead by the built-in ALLOWED entur.io entry.
    const declared = new Set([registrable("developer.entur.org")]);
    expect(isUndisclosed("api.entur.io", declared, ALLOWED)).toBe(true);
    const declaredWithIo = new Set([registrable("api.entur.io")]);
    expect(isUndisclosed("data.entur.io", declaredWithIo, ALLOWED)).toBe(false);
  });
});
