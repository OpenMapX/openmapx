import { describe, expect, it, vi } from "vitest";
import { applyNativeDeepLink, readNativeDeepLink } from "./nativeDeepLink";

describe("readNativeDeepLink", () => {
  it("reads a plain map query", () => {
    expect(readNativeDeepLink({ kind: "map", query: "?q=cafe&z=14" })).toEqual({
      kind: "map",
      query: "?q=cafe&z=14",
    });
  });

  it("reads an empty query", () => {
    expect(readNativeDeepLink({ kind: "map", query: "" })).toEqual({ kind: "map", query: "" });
  });

  it("reads the active-navigation intent", () => {
    expect(readNativeDeepLink({ kind: "active-navigation" })).toEqual({
      kind: "active-navigation",
    });
  });

  it.each([
    { label: "nothing", payload: undefined },
    { label: "a string", payload: "?q=cafe" },
    { label: "an unknown kind", payload: { kind: "open-url", query: "?q=cafe" } },
    { label: "a non-string query", payload: { kind: "map", query: 42 } },
    { label: "a query with no leading question mark", payload: { kind: "map", query: "q=cafe" } },
    { label: "a query carrying a fragment", payload: { kind: "map", query: "?q=cafe#/admin" } },
    { label: "a protocol-relative URL", payload: { kind: "map", query: "?//evil.example" } },
  ])("refuses $label", ({ payload }) => {
    // Sanitising would mean guessing what was meant, and nothing here has to
    // guess.
    expect(readNativeDeepLink(payload)).toBeNull();
  });

  it("refuses an oversize query", () => {
    expect(readNativeDeepLink({ kind: "map", query: `?q=${"x".repeat(3_000)}` })).toBeNull();
  });
});

describe("applyNativeDeepLink", () => {
  const deps = () => ({
    replaceSearch: vi.fn(),
    notify: vi.fn(),
    showActiveNavigation: vi.fn(),
    requestSnapshot: vi.fn(),
  });

  it("applies a map link through the machinery the browser already uses", () => {
    const d = deps();

    applyNativeDeepLink({ kind: "map", query: "?q=cafe" }, d);

    // One behaviour to get right rather than two that drift.
    expect(d.replaceSearch).toHaveBeenCalledWith("?q=cafe");
    expect(d.notify).toHaveBeenCalled();
    expect(d.showActiveNavigation).not.toHaveBeenCalled();
  });

  it("reconciles before showing the running trip", () => {
    const d = deps();

    applyNativeDeepLink({ kind: "active-navigation" }, d);

    // The page may have reloaded while the trip kept running natively.
    expect(d.requestSnapshot).toHaveBeenCalled();
    expect(d.showActiveNavigation).toHaveBeenCalled();
    expect(d.replaceSearch).not.toHaveBeenCalled();
  });
});
