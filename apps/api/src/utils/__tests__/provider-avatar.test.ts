import { describe, expect, it, vi } from "vitest";
import { createProviderAvatarSync, type ProviderAvatarDeps } from "../provider-avatar.js";

const CIPHERTEXT = "$ba$stored-ciphertext-never-sent-upstream";
const USABLE_TOKEN = "usable-plaintext-token";

function build(overrides: Partial<ProviderAvatarDeps> = {}) {
  const images = new Map<string, string | null>();
  const deps: ProviderAvatarDeps = {
    resolveAccessToken: vi.fn(async () => USABLE_TOKEN),
    fetchProviderImage: vi.fn(async () => "https://osm.example/avatar.png"),
    getCurrentImage: vi.fn(async (userId: string) => images.get(userId) ?? null),
    setUserImage: vi.fn(async (userId: string, image: string | null) => {
      images.set(userId, image);
    }),
    ...overrides,
  };
  return { sync: createProviderAvatarSync(deps), deps, images };
}

describe("account creation", () => {
  it("sets the image from the newly linked provider", async () => {
    const { sync, deps, images } = build();
    await sync.onAccountCreated("openstreetmap", "user-1");
    expect(deps.resolveAccessToken).toHaveBeenCalledWith("openstreetmap", "user-1");
    expect(images.get("user-1")).toBe("https://osm.example/avatar.png");
  });

  it("keeps an existing image", async () => {
    const { sync, deps } = build({
      getCurrentImage: vi.fn(async () => "https://existing.example"),
    });
    await sync.onAccountCreated("openstreetmap", "user-1");
    expect(deps.setUserImage).not.toHaveBeenCalled();
    expect(deps.resolveAccessToken).not.toHaveBeenCalled();
  });

  it("ignores providers outside the avatar list", async () => {
    const { sync, deps } = build();
    await sync.onAccountCreated("credential", "user-1");
    expect(deps.resolveAccessToken).not.toHaveBeenCalled();
  });
});

describe("account update", () => {
  it("refreshes the image after a token refresh", async () => {
    const { sync, images } = build();
    await sync.onAccountUpdated("openstreetmap", "user-1");
    expect(images.get("user-1")).toBe("https://osm.example/avatar.png");
  });

  it("clears the image when OpenStreetMap no longer has one", async () => {
    const { sync, deps } = build({ fetchProviderImage: vi.fn(async () => undefined) });
    await sync.onAccountUpdated("openstreetmap", "user-1");
    expect(deps.setUserImage).toHaveBeenCalledWith("user-1", null);
  });

  it("does not clear the image for a non-OpenStreetMap provider", async () => {
    const { sync, deps } = build({ fetchProviderImage: vi.fn(async () => undefined) });
    await sync.onAccountUpdated("mapillary", "user-1");
    expect(deps.setUserImage).not.toHaveBeenCalled();
  });

  it("does nothing when no usable token can be resolved", async () => {
    const { sync, deps } = build({ resolveAccessToken: vi.fn(async () => undefined) });
    await sync.onAccountUpdated("openstreetmap", "user-1");
    expect(deps.fetchProviderImage).not.toHaveBeenCalled();
    expect(deps.setUserImage).not.toHaveBeenCalled();
  });

  it("never sends a stored value upstream, only the resolved token", async () => {
    const fetchProviderImage = vi.fn(async (_provider: string, token: string) => {
      expect(token).toBe(USABLE_TOKEN);
      expect(token).not.toBe(CIPHERTEXT);
      return undefined;
    });
    const { sync } = build({ fetchProviderImage });
    await sync.onAccountUpdated("mapillary", "user-1");
    expect(fetchProviderImage).toHaveBeenCalledTimes(1);
  });
});

describe("recursion guard", () => {
  it("ignores a re-entrant update for the same user and provider", async () => {
    let inner: Promise<void> | undefined;
    const deps: Partial<ProviderAvatarDeps> = {};
    const { sync, deps: built } = build(deps);
    // Resolving a token can refresh and persist the account, which fires the
    // update hook again; the guard must swallow that second entry.
    (built.resolveAccessToken as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      inner = sync.onAccountUpdated("openstreetmap", "user-1");
      await inner;
      return USABLE_TOKEN;
    });
    await sync.onAccountUpdated("openstreetmap", "user-1");
    expect(built.resolveAccessToken).toHaveBeenCalledTimes(1);
    expect(built.setUserImage).toHaveBeenCalledTimes(1);
  });

  it("releases the guard so a later update still syncs", async () => {
    const { sync, deps } = build();
    await sync.onAccountUpdated("openstreetmap", "user-1");
    await sync.onAccountUpdated("openstreetmap", "user-1");
    expect(deps.resolveAccessToken).toHaveBeenCalledTimes(2);
  });

  it("keeps separate guards per user and provider", async () => {
    const { sync, deps } = build();
    await Promise.all([
      sync.onAccountUpdated("openstreetmap", "user-1"),
      sync.onAccountUpdated("openstreetmap", "user-2"),
      sync.onAccountUpdated("mapillary", "user-1"),
    ]);
    expect(deps.resolveAccessToken).toHaveBeenCalledTimes(3);
  });
});

describe("failure containment", () => {
  it("swallows a provider failure so sign-in is never blocked", async () => {
    const { sync } = build({
      fetchProviderImage: vi.fn(async () => {
        throw new Error("upstream down");
      }),
    });
    await expect(sync.onAccountUpdated("openstreetmap", "user-1")).resolves.toBeUndefined();
  });
});
