import { useNavigationStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_RELOAD_COOLDOWN_MS, markAutoReloaded } from "@/lib/swAutoUpdate";
import { SwUpdateNotice } from "./SwUpdateNotice";

let runtime = {
  isInstalledShell: false,
  state: "browser",
  handshake: null as unknown,
  readModel: null as unknown,
};
vi.mock("@/lib/mobile/MobileRuntimeProvider", () => ({ useMobileRuntimeContext: () => runtime }));

const sw = vi.hoisted(() => ({
  handlers: new Map<string, (event: { isUpdate?: boolean }) => void>(),
  skipWaiting: vi.fn(),
}));
vi.mock("@serwist/window", () => ({
  Serwist: class {
    addEventListener(type: string, handler: (event: { isUpdate?: boolean }) => void) {
      sw.handlers.set(type, handler);
    }
    register = async () => undefined;
    messageSkipWaiting = sw.skipWaiting;
  },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/offlineAreas/packageDownload", () => ({
  hasActiveOfflinePackageDownload: () => downloadActive,
}));
let downloadActive = false;
let queryClient: QueryClient;

function nativeVisibility(state: "active" | "background" | "inactive") {
  // What the installed shell's injected script does (apps/mobile
  // lifecycle/webVisibility.ts, tested there): mirror the app state onto Page
  // Visibility and announce a change. The web build cannot import the shell.
  const visibility = state === "active" ? "visible" : "hidden";
  const changed = document.visibilityState !== visibility;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => visibility === "hidden",
  });
  if (changed) document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
}
async function mountWaiting() {
  render(
    <QueryClientProvider client={queryClient}>
      <SwUpdateNotice />
    </QueryClientProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(sw.handlers.has("waiting")).toBe(true);
  act(() => sw.handlers.get("waiting")?.({ isUpdate: true }));
}

beforeEach(() => {
  vi.stubGlobal("process", { ...process, env: { ...process.env, NODE_ENV: "production" } });
  vi.useFakeTimers();
  sw.handlers.clear();
  sw.skipWaiting.mockClear();
  sessionStorage.clear();
  downloadActive = false;
  runtime = { isInstalledShell: false, state: "browser", handshake: null, readModel: null };
  queryClient = new QueryClient();
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { serviceWorker: {} }));
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  useNavigationStore.setState({ status: "idle", navigationAuthority: "browser" });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  delete (document as unknown as Record<string, unknown>).visibilityState;
  delete (document as unknown as Record<string, unknown>).hidden;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("waiting web updates", () => {
  it("applies on native background delivery even when WebView originally stayed visible", async () => {
    await mountWaiting();
    expect(sw.skipWaiting).not.toHaveBeenCalled();
    act(() => nativeVisibility("background"));
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
    act(() => nativeVisibility("active"));
    act(() => nativeVisibility("background"));
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("applies when a worker finishes installing while the shell is already hidden", async () => {
    nativeVisibility("background");
    await mountWaiting();
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it.each(["navigating", "rerouting", "mutation", "download", "text", "offline", "cooldown"])(
    "retains the update when blocked by %s and retries at a later safe background",
    async (blocker) => {
      runtime = {
        isInstalledShell: true,
        state: "native-compatible",
        handshake: { activeSession: { sessionId: "active" } },
        readModel: {},
      };
      await mountWaiting();
      const input = document.createElement("input");
      document.body.append(input);
      if (blocker === "navigating" || blocker === "rerouting") {
        useNavigationStore.setState({ navigationAuthority: "native", status: blocker });
      }
      const mutation = queryClient.getMutationCache().build(queryClient, {});
      if (blocker === "mutation") mutation.state.status = "pending";
      if (blocker === "download") downloadActive = true;
      if (blocker === "text") {
        input.value = "unsaved";
        input.focus();
      }
      if (blocker === "offline") Object.defineProperty(navigator, "onLine", { value: false });
      if (blocker === "cooldown") markAutoReloaded();
      act(() => nativeVisibility("background"));
      expect(sw.skipWaiting).not.toHaveBeenCalled();
      act(() => nativeVisibility("active"));
      useNavigationStore.setState({ status: "idle" });
      mutation.state.status = "success";
      downloadActive = false;
      input.remove();
      Object.defineProperty(navigator, "onLine", { value: true });
      act(() => vi.advanceTimersByTime(AUTO_RELOAD_COOLDOWN_MS));
      act(() => nativeVisibility("background"));
      expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["negotiating", "native-error", "native-incompatible", "awaiting-snapshot"])(
    "refuses an update while native navigation is unknown (%s)",
    async (state) => {
      runtime = {
        isInstalledShell: true,
        state: state === "awaiting-snapshot" ? "native-compatible" : state,
        handshake: { activeSession: { sessionId: "active" } },
        readModel: null,
      };
      await mountWaiting();
      act(() => nativeVisibility("background"));
      expect(sw.skipWaiting).not.toHaveBeenCalled();
    },
  );

  it("permits a negotiated shell with no native session", async () => {
    runtime = {
      isInstalledShell: true,
      state: "native-compatible",
      handshake: { activeSession: null },
      readModel: null,
    };
    await mountWaiting();
    act(() => nativeVisibility("background"));
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("preserves ordinary PWA visibility handling", async () => {
    await mountWaiting();
    Object.defineProperty(document, "visibilityState", { value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("keeps the visible snackbar and manual reload fallback", async () => {
    await mountWaiting();
    act(() => vi.advanceTimersByTime(30_000));
    expect(sw.skipWaiting).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });
});
