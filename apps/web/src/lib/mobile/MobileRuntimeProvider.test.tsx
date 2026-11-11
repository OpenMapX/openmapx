import { setNavigationAuthority, useNavigationStore } from "@openmapx/core";
import { MOBILE_PROTOCOL_MAX, MOBILE_PROTOCOL_MIN } from "@openmapx/core/navigation";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileRuntimeProvider } from "./MobileRuntimeProvider";
import { CHANNEL_GLOBAL } from "./mobileShellEnvironment";
import { useMobileRuntime, useNavigationModeAvailable } from "./useMobileRuntime";

const NONCE = "nonce-abc";

function shellScope(options: { transport?: boolean } = {}) {
  const sent: string[] = [];
  const handlers = new Map<string, (event: Event) => void>();

  const scope: Record<string, unknown> = {
    [CHANNEL_GLOBAL]: { nonce: NONCE },
    addEventListener: (type: string, handler: (event: Event) => void) => {
      handlers.set(type, handler);
    },
    removeEventListener: (type: string) => handlers.delete(type),
  };
  if (options.transport !== false) {
    scope.ReactNativeWebView = { postMessage: (message: string) => sent.push(message) };
  }

  const deliver = (detail: unknown) =>
    handlers.get("openmapx:native")?.({ detail } as unknown as Event);
  const fire = (type: string) => handlers.get(type)?.({} as Event);
  const isListening = (type: string) => handlers.has(type);

  return { scope, sent, deliver, fire, isListening };
}

function helloReply(forMessageId: string, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: MOBILE_PROTOCOL_MAX,
    type: "native.hello",
    messageId: "n1",
    channelNonce: NONCE,
    sentAtMs: 1_700_000_000_000,
    payload: {
      shellVersion: "1.0.0",
      shellBuild: "1",
      selectedProtocolVersion: MOBILE_PROTOCOL_MAX,
      minProtocolVersion: MOBILE_PROTOCOL_MIN,
      maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      platform: "ios",
      capabilities: {
        groundNavigation: true,
        transitNavigation: false,
        backgroundLocation: true,
        localNotifications: true,
        speech: true,
      },
      permission: "background",
      locationDriver: "expo",
      activeSession: null,
      forMessageId,
      ...overrides,
    },
  };
}

function deliverHello(
  shell: ReturnType<typeof shellScope>,
  overrides: Record<string, unknown> = {},
) {
  const forMessageId = JSON.parse(shell.sent[0]).messageId as string;
  shell.deliver(helloReply(forMessageId, overrides));
}

function Probe() {
  const runtime = useMobileRuntime();
  const ground = useNavigationModeAvailable("ground");
  const transit = useNavigationModeAvailable("transit");
  return (
    <div>
      <span data-testid="state">{runtime.state}</span>
      <span data-testid="browser-authority">{String(runtime.browserAuthority)}</span>
      <span data-testid="in-shell">{String(runtime.isInstalledShell)}</span>
      <span data-testid="microphone">{String(runtime.features.microphone)}</span>
      <span data-testid="ground">{String(ground)}</span>
      <span data-testid="transit">{String(transit)}</span>
      <span data-testid="revision">{runtime.session?.revision ?? "none"}</span>
    </div>
  );
}

function mount(scope?: unknown) {
  return render(
    <MobileRuntimeProvider webBuildId="web-build-1" scope={scope}>
      <Probe />
    </MobileRuntimeProvider>,
  );
}

const text = (testId: string) => screen.getByTestId(testId).textContent;

describe("MobileRuntimeProvider in an ordinary browser", () => {
  it("reports browser authority", () => {
    mount({});

    expect(text("state")).toBe("browser");
    expect(text("browser-authority")).toBe("true");
    expect(text("in-shell")).toBe("false");
    expect(text("microphone")).toBe("true");
    expect(text("ground")).toBe("true");
    expect(text("transit")).toBe("true");
    expect(useNavigationStore.getState().navigationAuthority).toBe("browser");
  });

  it("leaves page zoom alone", () => {
    document.head.innerHTML =
      '<meta name="viewport" content="width=device-width, maximum-scale=5">';
    mount({});

    expect(document.querySelector('meta[name="viewport"]')?.getAttribute("content")).toBe(
      "width=device-width, maximum-scale=5",
    );
    document.head.innerHTML = "";
  });
});

describe("MobileRuntimeProvider inside the shell", () => {
  it("starts negotiating rather than in browser authority", () => {
    // Even one frame of `browser` inside an installed app would let the browser
    // navigation engine start.

    document.head.innerHTML =
      '<meta name="viewport" content="width=device-width, maximum-scale=5">';
    try {
      const shell = shellScope();
      mount(shell.scope);

      expect(text("state")).toBe("negotiating");
      expect(text("browser-authority")).toBe("false");
      expect(text("in-shell")).toBe("true");
      expect(text("microphone")).toBe("false");
      expect(useNavigationStore.getState().navigationAuthority).toBe("native");
      expect(shell.sent).toHaveLength(1);
      expect(JSON.parse(shell.sent[0]).type).toBe("web.hello");
      expect(document.querySelector('meta[name="viewport"]')?.getAttribute("content")).toBe(
        "width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no",
      );
    } finally {
      document.head.innerHTML = "";
    }
  });

  it("reports only the modes the shell actually has a processor for", async () => {
    const shell = shellScope();
    mount(shell.scope);

    deliverHello(shell);

    await waitFor(() => expect(text("ground")).toBe("true"));
    expect(text("state")).toBe("native-compatible");
    expect(text("browser-authority")).toBe("false");
    // Claiming transit would strand the rider on a session nothing can advance.
    expect(text("transit")).toBe("false");
  });

  it("reports an old shell as incompatible, never as a browser", async () => {
    const shell = shellScope();
    mount(shell.scope);

    deliverHello(shell, { selectedProtocolVersion: null });

    await waitFor(() => expect(text("state")).toBe("native-incompatible"));
    expect(text("browser-authority")).toBe("false");
    expect(text("ground")).toBe("false");
  });

  it("reports a shell with no transport as an error, never as a browser", async () => {
    mount(shellScope({ transport: false }).scope);

    await waitFor(() => expect(text("state")).toBe("native-error"));
    expect(text("browser-authority")).toBe("false");
  });
});

describe("MobileRuntimeProvider read model", () => {
  async function negotiated() {
    const shell = shellScope();
    mount(shell.scope);
    deliverHello(shell);
    await waitFor(() => expect(text("state")).toBe("native-compatible"));
    shell.sent.length = 0;
    return shell;
  }

  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    protocolVersion: MOBILE_PROTOCOL_MAX,
    type: "snapshot.update",
    messageId: "n-snap",
    channelNonce: NONCE,
    sentAtMs: 1_700_000_000_000,
    payload: {
      snapshot: {
        version: 1,
        type: "full",
        kind: "ground",
        sessionId: "s1",
        revision: 4,
        routeFingerprint: "route-a",
        status: "active",
        ...overrides,
      },
    },
  });

  it("renders a newer delta after a dropped one without asking for a full snapshot", async () => {
    const shell = await negotiated();
    shell.deliver(snapshot());
    await waitFor(() => expect(text("revision")).toBe("4"));
    shell.sent.length = 0;

    shell.deliver(snapshot({ type: "progress", revision: 20, kind: undefined }));

    await waitFor(() => expect(text("revision")).toBe("20"));
    expect(shell.sent).toEqual([]);
  });

  it("asks for a full snapshot when a delta belongs to another route", async () => {
    const shell = await negotiated();
    shell.deliver(snapshot());
    await waitFor(() => expect(text("revision")).toBe("4"));
    shell.sent.length = 0;

    shell.deliver(
      snapshot({ type: "progress", revision: 5, kind: undefined, routeFingerprint: "route-b" }),
    );

    await waitFor(() => expect(shell.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(shell.sent[0]).type).toBe("snapshot.request");
    expect(text("revision")).toBe("4");
  });

  it("ignores a stale delta without asking for anything", async () => {
    const shell = await negotiated();
    shell.deliver(snapshot({ revision: 9 }));
    await waitFor(() => expect(text("revision")).toBe("9"));
    shell.sent.length = 0;

    shell.deliver(snapshot({ type: "progress", revision: 3, kind: undefined }));

    expect(text("revision")).toBe("9");
    expect(shell.sent).toEqual([]);
  });

  it("discovers a session that survived a reload", async () => {
    const shell = shellScope();
    mount(shell.scope);

    deliverHello(shell, {
      activeSession: { sessionId: "s1", revision: 12, kind: "ground" },
    });

    await waitFor(() => expect(shell.sent.length).toBeGreaterThan(1));
    expect(shell.sent.some((raw) => JSON.parse(raw).type === "snapshot.request")).toBe(true);
  });
});

describe("MobileRuntimeProvider store integration", () => {
  afterEach(() => {
    setNavigationAuthority("browser");
    useNavigationStore.getState().clearNativeReadModel();
  });

  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    protocolVersion: MOBILE_PROTOCOL_MAX,
    type: "snapshot.update",
    messageId: "n-snap",
    channelNonce: NONCE,
    sentAtMs: 1_700_000_000_000,
    payload: {
      snapshot: {
        version: 1,
        type: "full",
        kind: "ground",
        sessionId: "s1",
        revision: 4,
        routeFingerprint: "route-a",
        status: "active",
        route: { geometry: [[8.68, 50.11]] },
        alternatives: [],
        progress: { alongMeters: 100 },
        offRoute: false,
        coasting: false,
        currentSpeedLimit: 50,
        permissionMode: "background",
        ...overrides,
      },
    },
  });

  it("ignores late transit full responses but accepts a newer on-time prediction", async () => {
    const shell = shellScope();
    mount(shell.scope);
    deliverHello(shell);
    await waitFor(() => expect(text("state")).toBe("native-compatible"));
    const transit = (revision: number, departure: string) =>
      snapshot({
        kind: "transit",
        routeFingerprint: undefined,
        itineraryFingerprint: "bus-21",
        revision,
        liveStatus: { refresh: "broken", hasLiveToken: true },
        itinerary: {
          legs: [{ startTime: departure, scheduledStartTime: "2026-11-06T08:44:00Z" }],
          endTime: revision === 8 ? "2026-11-06T09:01:00Z" : "2026-11-06T09:00:00Z",
        },
        captures: [
          {
            legIndex: 0,
            tripId: "bus-21",
            status: "captured",
            capturedAtMs: 0,
            stops: [{ expectedDeparture: departure, scheduledDeparture: "2026-11-06T08:44:00Z" }],
          },
        ],
      });
    shell.deliver(transit(8, "2026-11-06T08:45:00Z"));
    await waitFor(() => expect(useNavigationStore.getState().nativeRevision).toBe(8));
    const delayed = useNavigationStore.getState();
    expect(delayed.itinerary?.legs[0].startTime).toBe("2026-11-06T08:45:00Z");
    expect(delayed.liveDataUnavailable).toBe(true);
    shell.sent.length = 0;
    shell.deliver(transit(7, "2026-11-06T08:44:00Z"));
    expect(useNavigationStore.getState().nativeRevision).toBe(8);
    expect(useNavigationStore.getState().itinerary).toBe(delayed.itinerary);
    expect(useNavigationStore.getState().transitCaptures).toBe(delayed.transitCaptures);
    expect(shell.sent).toEqual([]);
    shell.deliver(transit(9, "2026-11-06T08:44:00Z"));
    await waitFor(() => expect(useNavigationStore.getState().nativeRevision).toBe(9));
    expect(useNavigationStore.getState().itinerary?.legs[0].startTime).toBe("2026-11-06T08:44:00Z");
    expect(useNavigationStore.getState().transitCaptures[0].stops[0].expectedDeparture).toBe(
      "2026-11-06T08:44:00Z",
    );
  });

  it("updates the store when a snapshot arrives, never while React renders", async () => {
    // Applying the store inside a state updater ran it during the provider's
    // render, updating every map layer subscribed to the store mid-render.
    function RouteSubscriber() {
      const revision = useNavigationStore((s) => s.nativeRevision);
      return <span data-testid="store-revision">{revision ?? "none"}</span>;
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const shell = shellScope();
    render(
      <MobileRuntimeProvider webBuildId="web-build-1" scope={shell.scope}>
        <Probe />
        <RouteSubscriber />
      </MobileRuntimeProvider>,
    );
    deliverHello(shell);
    await waitFor(() => expect(text("state")).toBe("native-compatible"));

    shell.deliver(snapshot());
    await waitFor(() => expect(text("store-revision")).toBe("4"));
    expect(text("revision")).toBe("4");
    expect(useNavigationStore.getState()).toMatchObject({
      nativeRevision: 4,
      status: "navigating",
      currentSpeedLimit: 50,
      permissionMode: "background",
      progress: { alongMeters: 100 },
    });
    shell.deliver(
      snapshot({ type: "progress", revision: 5, kind: undefined, progress: { alongMeters: 200 } }),
    );
    await waitFor(() => expect(text("store-revision")).toBe("5"));
    expect(text("revision")).toBe("5");
    expect(useNavigationStore.getState().progress).toEqual({ alongMeters: 200 });
    shell.deliver(
      snapshot({ type: "progress", revision: 6, kind: undefined, progress: { alongMeters: 300 } }),
    );

    // Preserve the original batched-update regression after the per-step projection controls.
    shell.deliver(
      snapshot({ type: "progress", revision: 7, kind: undefined, progress: { alongMeters: 400 } }),
    );
    shell.deliver(
      snapshot({ type: "progress", revision: 8, kind: undefined, progress: { alongMeters: 500 } }),
    );
    await waitFor(() => expect(text("store-revision")).toBe("8"));
    expect(text("revision")).toBe("8");
    const renderPhaseUpdates = errors.mock.calls.filter((call) =>
      String(call[0]).includes("while rendering a different component"),
    );
    errors.mockRestore();
    expect(renderPhaseUpdates).toEqual([]);
  });

  it("updates displayed walking progress in order, across a dropped delta", async () => {
    function WalkSubscriber() {
      const p = useNavigationStore((s) => s.transitProgress);
      return (
        <span data-testid="walking-readout">
          {p?.currentWalkStepIndex}:{p?.distanceToNextStepMeters}:{p?.position?.[0]}
        </span>
      );
    }
    const shell = shellScope();
    render(
      <MobileRuntimeProvider webBuildId="web-build-1" scope={shell.scope}>
        <Probe />
        <WalkSubscriber />
      </MobileRuntimeProvider>,
    );
    deliverHello(shell);
    await waitFor(() => expect(text("state")).toBe("native-compatible"));
    const p = {
      currentLegIndex: 0,
      currentWalkStepIndex: 0,
      distanceToNextStepMeters: 100,
      phase: "walking",
      position: [8, 50],
      snapped: [8, 50],
      fractionAlongLeg: 0,
      deviationMeters: 0,
      arrived: false,
    };
    const transit = (overrides: Record<string, unknown>) =>
      snapshot({
        kind: "transit",
        routeFingerprint: undefined,
        itineraryFingerprint: "trip",
        itinerary: { legs: [] },
        transitProgress: p,
        ...overrides,
      });
    shell.deliver(transit({}));
    await waitFor(() => expect(text("walking-readout")).toBe("0:100:8"));
    shell.deliver(
      transit({
        type: "progress",
        revision: 5,
        transitProgress: { ...p, distanceToNextStepMeters: 60, position: [8.001, 50] },
      }),
    );
    await waitFor(() => expect(text("walking-readout")).toBe("0:60:8.001"));
    shell.deliver(
      transit({
        type: "progress",
        revision: 6,
        transitProgress: {
          ...p,
          currentWalkStepIndex: 1,
          distanceToNextStepMeters: 90,
          position: [8.002, 50],
        },
      }),
    );
    await waitFor(() => expect(text("walking-readout")).toBe("1:90:8.002"));
    shell.sent.length = 0;
    shell.deliver(
      transit({
        type: "progress",
        revision: 8,
        transitProgress: {
          ...p,
          currentWalkStepIndex: 2,
          distanceToNextStepMeters: 40,
          position: [8.003, 50],
        },
      }),
    );
    await waitFor(() => expect(text("walking-readout")).toBe("2:40:8.003"));
    expect(shell.sent.some((raw) => JSON.parse(raw).type === "snapshot.request")).toBe(false);
  });

  it.each(["visibilitychange", "online"] as const)("reconciles once after %s", async (event) => {
    const shell = shellScope();
    mount(shell.scope);
    deliverHello(shell);
    await waitFor(() => expect(text("state")).toBe("native-compatible"));
    await waitFor(() => expect(shell.isListening("visibilitychange")).toBe(true));
    expect(shell.isListening("online")).toBe(true);
    shell.sent.length = 0;

    act(() => shell.fire(event));

    await waitFor(() => expect(shell.sent.length).toBeGreaterThan(0));
    expect(shell.sent.map((raw) => JSON.parse(raw).type)).toEqual(["snapshot.request"]);
    act(() => {
      shell.fire("visibilitychange");
      shell.fire("online");
    });
    expect(shell.sent.map((raw) => JSON.parse(raw).type)).toEqual(["snapshot.request"]);
  });
});
