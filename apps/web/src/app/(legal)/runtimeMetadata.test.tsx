import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const metadata = vi.hoisted(() => vi.fn());
const legal = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core/server-api", () => ({
  fetchIntegrationMetadata: metadata,
  fetchLegalConfig: legal,
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
vi.mock("./privacy/content.en", () => ({ default: () => null }));
vi.mock("./terms/content.en", () => ({ default: () => null }));

beforeEach(() => {
  metadata.mockReset();
  legal.mockReset().mockResolvedValue(null);
});

describe.each(["privacy", "terms"])("%s runtime metadata", (page) => {
  it("passes integration and disclosure projections from exactly one acquisition", async () => {
    const snapshot = {
      revision: "a".repeat(64),
      integrations: [
        {
          id: "runtime-source",
          name: "Runtime source",
          enabled: true,
          isBuiltIn: true,
          domains: ["weather"],
        },
      ],
      frameworkStrings: {},
      disclosures: [
        { type: "email", provider: "smtp", vendorName: "", countryCode: "", transfer: "none" },
      ],
    };
    metadata.mockResolvedValue(snapshot);
    const Page =
      page === "privacy"
        ? (await import("./privacy/page")).default
        : (await import("./terms/page")).default;
    const result = (await Page()) as ReactElement<{
      children: ReactElement<Record<string, unknown>>;
    }>;
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(result.props.children.props).toMatchObject({
      integrations: snapshot.integrations,
      disclosures: snapshot.disclosures,
    });
    expect(result.props.children.props).not.toHaveProperty("capabilities");
  });

  it("preserves empty legal tables when metadata cannot be acquired", async () => {
    metadata.mockResolvedValue(null);
    const Page =
      page === "privacy"
        ? (await import("./privacy/page")).default
        : (await import("./terms/page")).default;
    const result = (await Page()) as ReactElement<{
      children: ReactElement<Record<string, unknown>>;
    }>;
    expect(result.props.children.props).toMatchObject({ integrations: [], disclosures: [] });
    expect(metadata).toHaveBeenCalledTimes(1);
  });
});
