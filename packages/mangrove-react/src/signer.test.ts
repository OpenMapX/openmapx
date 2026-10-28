import { describe, expect, it, vi } from "vitest";
import { createMangroveSigner, type SignerAccount, type SignerTransport } from "./signer";

const config = {
  configured: true as const,
  clientId: "client",
  redirectUri: "https://maps.test/auth/mangrove",
  signerUrl: "https://signer.mangrove.reviews",
  accountUrl: "https://mangrove.reviews/account",
};
function fixture(owner = "owner-a") {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
  let resolveAccount: ((v: SignerAccount) => void) | undefined;
  const transport: SignerTransport = {
    getConfig: async () => config,
    getAccount: async () => ({ reviewerId: "reviewer", publicPem: "PUBLIC" }),
    signReview: async () => {
      throw new Error("not used");
    },
    revokeSession: async () => undefined,
  };
  const controller = createMangroveSigner({
    owner,
    storage,
    transport,
    origin: "https://maps.test",
    now: () => 1000,
  });
  controller.activate();
  return {
    controller,
    values,
    transport,
    storage,
    holdAccount() {
      transport.getAccount = () =>
        new Promise((r) => {
          resolveAccount = r;
        });
    },
    finishAccount() {
      resolveAccount?.({ reviewerId: "reviewer", publicPem: "PUBLIC" });
    },
  };
}
describe("Mangrove signer authority", () => {
  it("does not revoke another owner's saved credential", async () => {
    const f = fixture();
    f.values.set(
      "openmapx.mangrove.signer",
      JSON.stringify({ owner: "owner-b", token: "secret".repeat(8) }),
    );
    f.transport.revokeSession = vi.fn(async () => undefined);
    await f.controller.disconnect();
    expect(f.transport.revokeSession).not.toHaveBeenCalled();
  });
  it("does not reopen login after choosing local signing during reconnect revocation", async () => {
    const f = fixture();
    const login = new URL(await f.controller.beginLogin("osm", "/"));
    await f.controller.acceptCallback(
      `https://maps.test/auth/mangrove#session_token=${"secret".repeat(8)}&state=${login.searchParams.get("state")}`,
    );
    let finish!: () => void;
    f.transport.revokeSession = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const reconnect = f.controller.beginLogin("osm", "/");
    const outcome = expect(reconnect).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.controller.selectLocal();
    finish();
    await outcome;
    expect(f.controller.getSnapshot().mode).toBe("local");
    expect(f.values.has("openmapx.mangrove.login")).toBe(false);
  });
  it("revokes an owner-bound saved credential even when restore could not load an account", async () => {
    const f = fixture();
    f.values.set(
      "openmapx.mangrove.signer",
      JSON.stringify({
        owner: "owner-a",
        token: "secret".repeat(8),
        registration: JSON.stringify([config.signerUrl, config.clientId, config.redirectUri]),
        createdAt: 1000,
      }),
    );
    f.transport.getAccount = async () => {
      throw new Error("outage");
    };
    f.transport.revokeSession = vi.fn(async () => undefined);
    await expect(f.controller.restore()).rejects.toThrow();
    expect(f.controller.getSnapshot().account).toBeNull();
    await f.controller.disconnect();
    expect(f.transport.revokeSession).toHaveBeenCalledWith("secret".repeat(8), expect.anything());
    expect(f.values.has("openmapx.mangrove.signer")).toBe(false);
  });
  it("revokes the previous session before replacing it during reconnect", async () => {
    const f = fixture();
    const login = new URL(await f.controller.beginLogin("osm", "/"));
    await f.controller.acceptCallback(
      `https://maps.test/auth/mangrove#session_token=${"secret".repeat(8)}&state=${login.searchParams.get("state")}`,
    );
    f.transport.revokeSession = vi.fn(async () => undefined);
    await f.controller.beginLogin("osm", "/");
    expect(f.transport.revokeSession).toHaveBeenCalledWith("secret".repeat(8), expect.anything());
  });
  it("rejects a callback without pending state and never exposes the bearer", async () => {
    const f = fixture();
    await expect(
      f.controller.acceptCallback(
        "https://maps.test/auth/mangrove#session_token=secret&state=other",
      ),
    ).rejects.toThrow();
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("secret");
  });
  it("consumes login state once and obtains identity from the account endpoint", async () => {
    const f = fixture();
    const url = new URL(await f.controller.beginLogin("osm", "/settings"));
    expect(url.origin).toBe("https://signer.mangrove.reviews");
    const callback = `https://maps.test/auth/mangrove#session_token=secretsecretsecretsecretsecretsecretsecretsecret&reviewer_id=forged&state=${url.searchParams.get("state")}`;
    expect(await f.controller.acceptCallback(callback)).toBe("/settings");
    expect(f.controller.getSnapshot().account?.reviewerId).toBe("reviewer");
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("secret");
    await expect(f.controller.acceptCallback(callback)).rejects.toThrow();
  });
  it("rejects duplicate state and a return URL outside this origin", async () => {
    const f = fixture();
    await expect(f.controller.beginLogin("osm", "//evil.test")).rejects.toThrow();
    const url = new URL(await f.controller.beginLogin("passkey", "/"));
    const state = url.searchParams.get("state");
    await expect(
      f.controller.acceptCallback(
        `https://maps.test/auth/mangrove#session_token=secretsecretsecretsecretsecretsecretsecretsecret&state=${state}&state=${state}`,
      ),
    ).rejects.toThrow();
  });
  it("does not restore authority when an account response arrives after disposal", async () => {
    const f = fixture();
    const url = new URL(await f.controller.beginLogin("osm", "/"));
    f.holdAccount();
    const pending = f.controller.acceptCallback(
      `https://maps.test/auth/mangrove#session_token=secretsecretsecretsecretsecretsecretsecretsecret&state=${url.searchParams.get("state")}`,
    );
    await new Promise((r) => setTimeout(r, 0));
    f.controller.dispose();
    f.finishAccount();
    await expect(pending).rejects.toThrow();
    expect(f.controller.getSnapshot().account).toBeNull();
  });
  it("rejects pending callbacks from a different authentication session", async () => {
    const f = fixture();
    const url = new URL(await f.controller.beginLogin("osm", "/"));
    const other = createMangroveSigner({
      owner: "owner-b",
      storage: f.storage,
      transport: f.transport,
      origin: "https://maps.test",
      now: () => 1000,
    });
    other.activate();
    await expect(
      other.acceptCallback(
        `https://maps.test/auth/mangrove#session_token=secretsecretsecretsecretsecretsecretsecretsecret&state=${url.searchParams.get("state")}`,
      ),
    ).rejects.toThrow();
  });
  it("distinguishes expiry from an outage without changing identity", async () => {
    const f = fixture();
    const login = new URL(await f.controller.beginLogin("osm", "/"));
    await f.controller.acceptCallback(
      `https://maps.test/auth/mangrove#session_token=${"secret".repeat(8)}&state=${login.searchParams.get("state")}`,
    );
    f.transport.signReview = async () => {
      throw Object.assign(new Error("untrusted upstream body"), { status: 503 });
    };
    await expect(f.controller.sign({ sub: "https://example.test", rating: 80 })).rejects.toThrow(
      "Mangrove connection unavailable",
    );
    expect(f.controller.getSnapshot().account?.publicPem).toBe("PUBLIC");
    expect(f.controller.getSnapshot().mode).toBe("signer");
    f.transport.signReview = async () => {
      throw Object.assign(new Error("untrusted upstream body"), { status: 401 });
    };
    await expect(f.controller.sign({ sub: "https://example.test", rating: 80 })).rejects.toThrow(
      "Mangrove login expired",
    );
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "signer",
      status: "expired",
      account: null,
    });
    expect([...f.values.values()].join("")).not.toContain("secret".repeat(8));
  });
  it("rejects expired login state without contacting the account endpoint", async () => {
    const f = fixture();
    const login = new URL(await f.controller.beginLogin("passkey", "/"));
    const later = createMangroveSigner({
      owner: "owner-a",
      origin: "https://maps.test",
      storage: f.storage,
      transport: {
        ...f.transport,
        getAccount: async () => {
          throw new Error("must not contact account");
        },
      },
      now: () => 601001,
    });
    later.activate();
    await expect(
      later.acceptCallback(
        `https://maps.test/auth/mangrove#session_token=${"secret".repeat(8)}&state=${login.searchParams.get("state")}`,
      ),
    ).rejects.toThrow("Mangrove connection unavailable");
    expect(later.getSnapshot().account).toBeNull();
  });
  it("keeps a valid session across temporary configuration unavailability", async () => {
    const f = fixture();
    const login = new URL(await f.controller.beginLogin("osm", "/"));
    await f.controller.acceptCallback(
      `https://maps.test/auth/mangrove#session_token=${"secret".repeat(8)}&state=${login.searchParams.get("state")}`,
    );
    f.transport.getConfig = async () => ({ configured: false });
    await expect(
      f.controller.sign({ sub: "https://example.test", rating: 80 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.controller.getSnapshot().account?.reviewerId).toBe("reviewer");
    expect([...f.values.values()].join("")).toContain("secret".repeat(8));
    f.controller.dispose();
    f.controller.activate();
    await f.controller.restore();
    expect([...f.values.values()].join("")).toContain("secret".repeat(8));
    f.transport.getConfig = async () => config;
    await f.controller.restore();
    expect(f.controller.getSnapshot()).toMatchObject({
      status: "connected",
      account: { reviewerId: "reviewer" },
    });
  });
});
