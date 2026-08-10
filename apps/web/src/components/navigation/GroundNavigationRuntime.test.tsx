import { setNavigationAuthority, useNavigationStore } from "@openmapx/core";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_GLOBAL } from "@/lib/mobile/mobileShellEnvironment";

const calls = { engine: 0, camera: 0, wakeLock: [] as boolean[], incidentResource: 0 };

vi.mock("@/lib/navigation/useNavigationEngine", () => ({
  useNavigationEngine: () => {
    calls.engine += 1;
  },
}));
vi.mock("@/lib/navigation/useNavCamera", () => ({
  useNavCamera: () => {
    calls.camera += 1;
  },
}));
vi.mock("@/lib/useWakeLock", () => ({
  useWakeLock: (enabled: boolean) => {
    calls.wakeLock.push(enabled);
  },
}));
vi.mock("@openmapx/integration-framework/react", () => ({
  useNavIncidentResource: () => {
    calls.incidentResource += 1;
    return null;
  },
}));

const { GroundNavigationRuntime } = await import("./GroundNavigationRuntime");
const { MobileRuntimeProvider } = await import("@/lib/mobile/MobileRuntimeProvider");

function mount(scope?: unknown) {
  return render(
    <MobileRuntimeProvider webBuildId="web-build-1" scope={scope}>
      <GroundNavigationRuntime />
    </MobileRuntimeProvider>,
  );
}

const shellScope = () => ({
  [CHANNEL_GLOBAL]: { nonce: "abc123" },
  addEventListener: () => {},
  removeEventListener: () => {},
  ReactNativeWebView: { postMessage: () => {} },
});

describe("GroundNavigationRuntime", () => {
  beforeEach(() => {
    calls.engine = 0;
    calls.camera = 0;
    calls.wakeLock = [];
    calls.incidentResource = 0;
  });

  afterEach(() => {
    setNavigationAuthority("browser");
    useNavigationStore.getState().clearNativeReadModel();
  });

  it("runs the browser engine, wake lock and incidents in an ordinary browser", () => {
    mount({});

    expect(calls.engine).toBeGreaterThan(0);
    expect(calls.wakeLock.length).toBeGreaterThan(0);
    expect(calls.incidentResource).toBeGreaterThan(0);
  });

  it("runs none of them inside the installed shell", () => {
    mount(shellScope());

    // Each has a native owner already. A second GPS watch, a second reroute
    // decision, or a second wake lock is a way for the two to disagree.
    expect(calls.engine).toBe(0);
    expect(calls.wakeLock).toEqual([]);
    expect(calls.incidentResource).toBe(0);
  });

  it("keeps the camera following in both runtimes", () => {
    mount({});
    const inBrowser = calls.camera;
    calls.camera = 0;
    mount(shellScope());

    // Rendering is the one thing both authorities share: under native authority
    // the store still says where the puck is, it just did not decide it.
    expect(inBrowser).toBeGreaterThan(0);
    expect(calls.camera).toBeGreaterThan(0);
  });
});
