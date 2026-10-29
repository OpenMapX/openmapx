import { afterEach, describe, expect, it, vi } from "vitest";
import { configureApiClient } from "./client";
import { fetchIntegrationMetadata } from "./integrations";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("server integration metadata acquisition", () => {
  it("uses one validated no-store snapshot from the internal origin, independently of browser configuration", async () => {
    vi.stubEnv("INTERNAL_API_URL", "https://internal.example.test/");
    configureApiClient({ baseUrl: "https://browser.example.test", credentials: "include" });
    const snapshot = {
      revision: "a".repeat(64),
      integrations: [],
      frameworkStrings: { en: { nested: [null, 3, true] } },
      disclosures: [
        { type: "email", provider: "smtp", vendorName: "", countryCode: "", transfer: "none" },
      ],
    };
    const fetch = vi.fn(async () => Response.json(snapshot));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchIntegrationMetadata()).toEqual(snapshot);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://internal.example.test/api/integrations",
      expect.objectContaining({ cache: "no-store", credentials: "omit" }),
    );
  });

  it("returns the feature-level fallback for malformed JSON and acquisition failures", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ integrations: [] }));
    expect(await fetchIntegrationMetadata()).toBeNull();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
    expect(await fetchIntegrationMetadata()).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await fetchIntegrationMetadata()).toBeNull();
  });
});
