import type { RoadConditionRouteImpact, Route, Waypoint } from "@openmapx/core";
import {
  setNavigationAuthority,
  useDirectionsStore,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileRuntimeProvider } from "@/lib/mobile/MobileRuntimeProvider";
import { createQueryWrapper } from "@/test";
import {
  createNativeShellScope,
  NATIVE_SHELL_HELLO_PAYLOAD,
  nativeSessionMessageTypes,
  waitForNativeShellNegotiated,
} from "@/test/nativeShell";
import { DetailsView } from "./DetailsView";
import { MultiStopRouteSummary } from "./MultiStopRouteSummary";
import { useGroundRouteStart } from "./useGroundRouteStart";

afterEach(cleanup);

const ORIGIN: [number, number] = [13.3777, 52.5163];
const MIDSTOP: [number, number] = [13.4397, 52.505];
const DESTINATION: [number, number] = [13.295, 52.52];

const WAYPOINTS: Waypoint[] = [
  { id: "a", label: "Brandenburg Gate", coords: ORIGIN, type: "origin" },
  { id: "b", label: "East Side Gallery", coords: MIDSTOP, type: "waypoint" },
  { id: "c", label: "Charlottenburg", coords: DESTINATION, type: "destination" },
];

const WAYPOINT_COORDS: [number, number][] = [ORIGIN, MIDSTOP, DESTINATION];

const multiStopRoute: Route = {
  mode: "driving",
  distance: 15_200,
  duration: 1_920,
  geometry: WAYPOINT_COORDS,
  legs: [
    {
      distance: 5_400,
      duration: 720,
      geometry: [ORIGIN, MIDSTOP],
      steps: [],
    },
    {
      distance: 9_800,
      duration: 1_200,
      geometry: [MIDSTOP, DESTINATION],
      steps: [],
    },
  ],
  steps: [],
};

function renderSummary(
  overrides: Partial<React.ComponentProps<typeof MultiStopRouteSummary>> = {},
) {
  const onDetails = vi.fn();
  const view = render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <MultiStopRouteSummary
        route={multiStopRoute}
        waypoints={WAYPOINTS}
        units="metric"
        onDetails={onDetails}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
  return { view, onDetails };
}

function renderInShell(
  reply: (type: string) => unknown | Promise<unknown>,
  onDetails: () => void = () => {},
) {
  const { scope, sent } = createNativeShellScope(reply, "nonce-multi");

  const view = render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <MobileRuntimeProvider webBuildId="web-build-1" scope={scope}>
        <MultiStopRouteSummary
          route={multiStopRoute}
          waypoints={WAYPOINTS}
          units="metric"
          provider="routing-valhalla"
          onDetails={onDetails}
        />
      </MobileRuntimeProvider>
    </NextIntlClientProvider>,
  );
  const start = () => view.getByRole("button", { name: "Start" });
  return { sent, view, start };
}

function SummaryAndDetailsHarness({ route }: { route: Route }) {
  const [inDetails, setInDetails] = useState(false);
  if (!inDetails) {
    return (
      <MultiStopRouteSummary
        route={route}
        waypoints={WAYPOINTS}
        units="metric"
        provider="routing-valhalla"
        onDetails={() => setInDetails(true)}
      />
    );
  }
  return <DetailsHarness route={route} onBack={() => setInDetails(false)} />;
}

function DetailsHarness({ route, onBack }: { route: Route; onBack: () => void }) {
  const { canStart, start, starting, startError } = useGroundRouteStart({
    route,
    waypoints: WAYPOINTS,
    index: 0,
    provider: "routing-valhalla",
    units: "metric",
  });
  return (
    <DetailsView
      route={route}
      originLabel="Brandenburg Gate"
      destinationLabel="Charlottenburg"
      waypointLabels={WAYPOINTS.map((w) => w.label)}
      units="metric"
      onBack={onBack}
      onStart={canStart ? () => void start() : undefined}
      startDisabled={starting}
      startError={startError}
    />
  );
}

describe("MultiStopRouteSummary Start under browser authority", () => {
  beforeEach(() => {
    useDirectionsStore.setState({
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: false,
    });
    useSettingsStore.setState({ avoidIncidents: false });
  });

  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
  });

  it.each(["driving", "walking", "cycling", "motorcycle"] as const)(
    "shows Start for %s and starts navigation with every stop in destinationWaypoints",
    async (mode) => {
      const roadConditionImpact: RoadConditionRouteImpact = {
        availability: "limited",
        evaluatedAt: "2026-09-12T12:00:00Z",
        validUntil: null,
        reasons: ["planned_closure_on_route"],
      };
      useDirectionsStore.setState({ avoidHighways: true, avoidTolls: true, avoidFerries: true });
      useSettingsStore.setState({ avoidIncidents: true });

      const route = { ...multiStopRoute, mode };
      const { onDetails } = renderSummary({
        route,
        provider: "routing-valhalla",
        roadConditionImpact,
      });

      const startButton = screen.getByRole("button", { name: "Start" });
      fireEvent.click(startButton);

      await waitFor(() =>
        expect(useNavigationStore.getState()).toMatchObject({
          status: "navigating",
          kind: "ground",
          mode,
          route,
          destinationWaypoints: WAYPOINT_COORDS,
          routeProvider: "routing-valhalla",
          routeSelectionIntent: "automatic",
          roadConditionImpact,
          routeOptions: {
            avoidHighways: mode === "driving",
            avoidTolls: mode === "driving",
            avoidFerries: true,
            avoidClosures: true,
          },
        }),
      );
      expect(onDetails).not.toHaveBeenCalled();
    },
  );

  it.each(["transit", "flying", "ride"] as const)(
    "omits Start for %s routes without turn-by-turn guidance",
    (mode) => {
      renderSummary({ route: { ...multiStopRoute, mode } });
      expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    },
  );

  it("opens Details from both the Details button and the summary body", () => {
    const { onDetails } = renderSummary();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(onDetails).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/Brandenburg Gate/));
    expect(onDetails).toHaveBeenCalledTimes(2);
  });

  it("does not open Details when a click lands on the actions row (e.g. through a disabled Start button)", () => {
    const { view, onDetails } = renderSummary();
    const actionsRow = view.container.querySelector("[data-route-actions]");
    expect(actionsRow).not.toBeNull();
    fireEvent.click(actionsRow as Element);
    expect(onDetails).not.toHaveBeenCalled();
  });
});

describe("MultiStopRouteSummary Start under native authority", () => {
  afterEach(() => {
    setNavigationAuthority("browser");
    useNavigationStore.getState().clearNativeReadModel();
  });

  const compatibleShell = (type: string) => {
    if (type === "web.hello") return NATIVE_SHELL_HELLO_PAYLOAD;
    if (type === "session.prepare") return { sessionId: "s1", revision: 1 };
    if (type === "session.start") return { sessionId: "s1", revision: 2 };
    return undefined;
  };

  it("prepares and starts natively with every stop in destinationWaypoints", async () => {
    const onDetails = vi.fn();
    const { sent, start } = renderInShell(compatibleShell, onDetails);
    await waitForNativeShellNegotiated(sent);

    fireEvent.click(start());

    await waitFor(() =>
      expect(nativeSessionMessageTypes(sent)).toEqual(["session.prepare", "session.start"]),
    );
    expect(sent.find((message) => message.type === "session.prepare")?.payload).toMatchObject({
      startPackage: {
        kind: "ground",
        mode: "driving",
        destinationWaypoints: WAYPOINT_COORDS,
        routeProvider: "routing-valhalla",
      },
    });
    expect(useNavigationStore.getState().status).toBe("idle");
    expect(onDetails).not.toHaveBeenCalled();
  });

  it("guards against duplicate taps while preparing and does not open Details", async () => {
    const onDetails = vi.fn();
    const { sent, start, view } = renderInShell(
      (type) => (type === "web.hello" ? NATIVE_SHELL_HELLO_PAYLOAD : undefined),
      onDetails,
    );
    await waitForNativeShellNegotiated(sent);

    const button = start();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(nativeSessionMessageTypes(sent)).toEqual(["session.prepare"]));
    expect(button).toBeDisabled();
    // Simulate a real browser click on a disabled MUI button (pointer-events: none -> row wrapper).
    fireEvent.click(view.container.querySelector("[data-route-actions]") as Element);

    expect(nativeSessionMessageTypes(sent)).toEqual(["session.prepare"]);
    expect(onDetails).not.toHaveBeenCalled();
  });

  it("keeps Start disabled and preserves start errors when opening Details mid-prepare", async () => {
    let resolvePrepare: ((value: unknown) => void) | undefined;
    const { scope, sent } = createNativeShellScope((type) => {
      if (type === "web.hello") return NATIVE_SHELL_HELLO_PAYLOAD;
      if (type === "session.prepare") {
        return new Promise((resolve) => {
          resolvePrepare = resolve;
        });
      }
      return undefined;
    }, "nonce-handoff");

    const view = render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <MobileRuntimeProvider webBuildId="web-build-1" scope={scope}>
          <SummaryAndDetailsHarness route={multiStopRoute} />
        </MobileRuntimeProvider>
      </NextIntlClientProvider>,
      { wrapper: createQueryWrapper() },
    );
    await waitForNativeShellNegotiated(sent);

    fireEvent.click(view.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(nativeSessionMessageTypes(sent)).toEqual(["session.prepare"]));

    // Opening Details while prepare is in flight must keep Start disabled and refuse a second start.
    fireEvent.click(view.getByRole("button", { name: "Details" }));
    const detailsStart = await view.findByRole("button", { name: "Start" });
    expect(detailsStart).toBeDisabled();
    fireEvent.click(detailsStart);
    expect(nativeSessionMessageTypes(sent)).toEqual(["session.prepare"]);

    // A failure arriving after switching to Details surfaces on the Details view.
    resolvePrepare?.({ nativeError: "rejected" });
    expect((await view.findByRole("alert")).textContent).toBe(en.navigation.startFailed);
  });

  it("shows the update-required error on an incompatible shell without starting browser nav", async () => {
    const { sent, start, view } = renderInShell((type) =>
      type === "web.hello"
        ? { ...NATIVE_SHELL_HELLO_PAYLOAD, selectedProtocolVersion: null }
        : undefined,
    );
    await waitForNativeShellNegotiated(sent);

    fireEvent.click(start());

    expect((await view.findByRole("alert")).textContent).toBe(en.navigation.startUpdateRequired);
    expect(nativeSessionMessageTypes(sent)).toEqual([]);
    expect(useNavigationStore.getState().status).toBe("idle");
  });
});
