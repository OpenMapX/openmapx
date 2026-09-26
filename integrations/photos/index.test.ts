import type { PlacePhoto } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

describe("photo search route", () => {
  it("removes cached Commons media icons before returning gallery photos", async () => {
    const realPhoto: PlacePhoto = {
      url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/be/Aachen.jpg/800px-Aachen.jpg",
      source: "wikimedia",
      author: "CEphoto, Uwe Aranas",
      license: "CC BY-SA 3.0",
    };
    let handler: ((req: unknown, reply: unknown) => Promise<void>) | undefined;
    setup({
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
});
