import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

// Next's matcher helper pulls in server modules that expect this global, which
// the Next server installs at startup. Set it before loading the helper.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
const runsFor = (url: string) => unstable_doesMiddlewareMatch({ config, url });

describe("proxy matcher", () => {
  it.each([
    "/",
    "/s/abc",
    // Page routes whose path happens to end in an asset extension.
    "/s/abc.png",
    "/nope.png",
    "/admin/x.svg",
    // Page routes that only share a prefix with an excluded location.
    "/apikeys",
    "/iconsfoo",
    "/_nextfoo",
    "/styles",
    "/manifest.webmanifest",
    "/osm-logo.svg",
  ])("runs for %s", (url) => {
    expect(runsFor(url)).toBe(true);
  });

  it.each([
    "/_next/static/chunks/a.js",
    "/_next/image",
    "/api",
    "/api/v1/x",
    "/favicon.ico",
    "/sw.js",
    "/icons/app/icon-192.png",
    "/fonts/MaterialIcons-Regular.woff2",
    "/styles/sprite.json",
    "/attribution/tdx.png",
  ])("skips %s", (url) => {
    expect(runsFor(url)).toBe(false);
  });
});

const request = () => new NextRequest("https://openmapx.test/directions?to=1");

describe("proxy CSP", () => {
  it("sets one policy on the response", () => {
    const response = proxy(request());

    const csp = response.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-");
  });

  it("gives every request its own nonce", () => {
    const first = proxy(request()).headers.get("x-nonce");
    const second = proxy(request()).headers.get("x-nonce");

    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("puts the same nonce in the policy and the header", () => {
    const response = proxy(request());

    const nonce = response.headers.get("x-nonce");
    // The render reads the header; the browser enforces the policy. If they
    // disagree, every framework script is blocked.
    expect(response.headers.get("Content-Security-Policy")).toContain(`'nonce-${nonce}'`);
  });
});
