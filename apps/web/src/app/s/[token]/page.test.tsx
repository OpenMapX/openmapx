import { afterEach, expect, it, vi } from "vitest";

vi.mock("@openmapx/core/server-api", () => ({
  serverApiUrl: () => "https://share-server.example",
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("./SharedViewClient", () => ({ SharedViewClient: () => null }));

import { generateMetadata } from "./page";

afterEach(() => vi.unstubAllGlobals());
it("maps malformed successful public replies to unavailable metadata", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { headers: { "cache-control": "no-store" } })),
  );
  await expect(
    generateMetadata({ params: Promise.resolve({ token: "A".repeat(43) }) }),
  ).resolves.toMatchObject({ title: "OpenMapX" });
});
