import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime: {
  state: string;
  browserAuthority: boolean;
  handshake: { platform: string } | null;
  client: { request: ReturnType<typeof vi.fn> } | null;
} = { state: "native-compatible", browserAuthority: false, handshake: null, client: null };

vi.mock("./MobileRuntimeProvider", () => ({ useMobileRuntimeContext: () => runtime }));
vi.mock("@openmapx/core", () => ({
  apiUrl: (path: string) => `https://openmapx.test${path}`,
  authClient: { oneTimeToken: { verify: vi.fn() }, getSession: vi.fn() },
}));

const { useSystemAuth } = await import("./useSystemAuth");

const run = () => renderHook(() => useSystemAuth()).result.current.runSystemAuth("sign-in");

beforeEach(() => {
  runtime.state = "native-compatible";
  runtime.client = { request: vi.fn() };
});

describe("useSystemAuth outcomes", () => {
  it("reports unsupported only when the shell refuses this device", async () => {
    runtime.client?.request.mockResolvedValue({
      type: "auth.result",
      payload: { requestId: "auth-sign-in", status: "unsupported" },
    });

    await expect(run()).resolves.toBe("unsupported");
  });

  it.each([
    ["the request times out", new Error("timeout")],
    ["the channel resets", new Error("channel-reset")],
    ["there is no transport", new Error("no-transport")],
    ["too many requests are pending", new Error("too-many-pending")],
  ])("reports a bridge failure as failed when %s", async (_label, error) => {
    runtime.client?.request.mockRejectedValue(error);

    await expect(run()).resolves.toBe("failed");
  });

  it("reports failed when there is no compatible shell to ask", async () => {
    runtime.client = null;
    await expect(run()).resolves.toBe("failed");
    runtime.client = { request: vi.fn() };
    runtime.state = "browser";
    await expect(run()).resolves.toBe("failed");
  });
});
