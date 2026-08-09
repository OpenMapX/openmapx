import { describe, expect, it, vi } from "vitest";
import { createPinnedFetchTransport } from "../utils/pinned-fetch.js";

const publicAddress = [{ address: "93.184.216.34", family: 4 as const }];

describe("createPinnedFetchTransport", () => {
  it("closes a pinned dispatcher after its successful response is released", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const createDispatcher = vi.fn(() => ({ close, destroy: vi.fn() }));
    const transport = createPinnedFetchTransport({
      createDispatcher,
      fetchImplementation: vi.fn().mockResolvedValue(new Response('{"ok":true}')),
    });

    const response = await transport.fetch("https://public.test/data", publicAddress, {});
    await transport.releaseResponse(response);

    expect(createDispatcher).toHaveBeenCalledWith(publicAddress);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a pinned dispatcher when connecting fails before a response exists", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const transport = createPinnedFetchTransport({
      createDispatcher: () => ({ close, destroy: vi.fn() }),
      fetchImplementation: vi.fn().mockRejectedValue(new Error("connection aborted")),
    });

    await expect(transport.fetch("https://public.test/data", publicAddress, {})).rejects.toThrow(
      "connection aborted",
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
