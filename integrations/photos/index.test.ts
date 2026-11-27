import type { PlacePhoto } from "@openmapx/core";
import type { IntegrationContext, LoadedIntegration } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  routeRequest,
} from "@openmapx/integration-framework/testing";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

describe("photo search route", () => {
  it("removes cached Commons media icons before returning gallery photos", async () => {
    const realPhoto: PlacePhoto = {
      url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/be/Aachen.jpg/800px-Aachen.jpg",
      source: "wikimedia",
      author: "CEphoto, Uwe Aranas",
      licensing: licensingFromDeclaration(
        "CC BY-SA 3.0",
        "https://creativecommons.org/licenses/by-sa/3.0/",
      ),
      pageUrl: "https://commons.wikimedia.org/wiki/File:Aachen.jpg",
    };
    let handler: ((req: unknown, reply: unknown) => Promise<void>) | undefined;
    setup({
      registerPhotoProvider: vi.fn(),
      registerRoute: (_method: string, _path: string, routeHandler: typeof handler) => {
        handler = routeHandler;
      },
      cache: {
        withCache: vi.fn().mockResolvedValue([
          {
            url: "https://commons.wikimedia.org/w/resources/assets/file-type-icons/fileicon-ogg.png",
            source: "wikimedia",
            pageUrl: "https://commons.wikimedia.org/wiki/File:De-Aachen.ogg",
          },
          realPhoto,
        ]),
      },
    } as unknown as IntegrationContext);
    const send = vi.fn();
    const reply = { header: vi.fn(), send, status: vi.fn() };

    await handler?.({ query: { lat: "50.776351", lng: "6.083862" } }, reply);

    expect(send).toHaveBeenCalledWith({ photos: [realPhoto] });
  });

  it("drops photos of a provider whose integration is disallowed", async () => {
    const photo = (name: string): PlacePhoto => ({
      url: `https://images.example.org/${name}.jpg`,
      source: "shared-source",
    });
    const provider = (id: string) => ({
      id,
      name: id,
      search: vi.fn(async () => [photo(id)]),
    });
    const integrations = ["photos-acme", "photos-other"].map((id) => ({
      id,
      enabled: true,
      config: {},
      manifest: { id, domains: ["photos"] },
      providers: new Map([["photos", [provider(id.slice(7))]]]),
    })) as unknown as LoadedIntegration[];
    const keys: string[] = [];
    const ctx = createMockIntegrationContext({ id: "photos" });
    ctx.getIntegrationsByDomain = (domain) => (domain === "photos" ? integrations : []);
    ctx.cache.withCache = async <T>(
      key: string,
      _ttl: number,
      load: (signal: AbortSignal) => Promise<T>,
    ) => {
      keys.push(key);
      return load(new AbortController().signal);
    };
    let disallowed = new Set<string>();
    ctx.getDisallowedIntegrationIds = async () => disallowed;
    setup(ctx);
    const route = ctx.registered.routes.find((r) => r.path === "/search");
    if (!route) throw new Error("missing photo route");
    const read = async () => {
      let body: { photos: PlacePhoto[] } | undefined;
      const reply = {
        header: () => reply,
        status: () => reply,
        type: () => reply,
        send: (value: unknown) => {
          body = value as { photos: PlacePhoto[] };
          return reply;
        },
      };
      await route.handler(
        routeRequest({ query: { lat: "50.77", lng: "6.08" }, body: null }),
        reply,
      );
      return body?.photos.map((entry) => entry.url) ?? [];
    };
    expect(await read()).toEqual([
      "https://images.example.org/acme.jpg",
      "https://images.example.org/other.jpg",
    ]);
    disallowed = new Set(["photos-acme"]);
    expect(await read()).toEqual(["https://images.example.org/other.jpg"]);
    // The cached gallery of the earlier policy is not served under the new one.
    expect(keys[1]).not.toBe(keys[0]);
  });
});
