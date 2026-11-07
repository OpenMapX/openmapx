import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

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
