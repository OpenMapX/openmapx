import type { PersonalVehicle, RoadConditionRouteImpact, Route, RouteImpact } from "@openmapx/core";
import { setNavigationAuthority, useDirectionsStore, useNavigationStore } from "@openmapx/core";
import { MOBILE_PROTOCOL_MAX, MOBILE_PROTOCOL_MIN } from "@openmapx/core/navigation";
import { de, en } from "@openmapx/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileRuntimeProvider } from "@/lib/mobile/MobileRuntimeProvider";
import { RouteCard } from "./RouteCard";

// Pin the viewer's zone so the arrival offset assertions do not depend on the
// machine running the suite.
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return { ...actual, viewerTimeZone: () => "Europe/Berlin" };
});

// This project does not enable Testing Library's automatic cleanup, so without
// this every render in the file stays in the document and role queries find
// several Start buttons.
afterEach(cleanup);

const baseRoute: Route = {
  distance: 118132,
  duration: 5194,
  geometry: [
    [6.08, 50.77],
    [6.68, 51.51],
  ],
  legs: [],
  steps: [],
  mode: "driving",
  summary: "via A46",
};

const renderCard = (
  route: Route,
  units: "metric" | "imperial" = "metric",
  locale: "en" | "de" = "en",
) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "de" ? de : en}
      timeZone="Europe/Berlin"
    >
      <RouteCard
        route={route}
        index={0}
        active
        onSelect={() => {}}
        onDetails={() => {}}
        units={units}
      />
    </NextIntlClientProvider>,
  );

describe("RouteCard ascent", () => {
  const uphill = { ...baseRoute, elevation: [100, 110, 120, 130], elevationInterval: 30 };

  it.each(["walking", "cycling"] as const)("shows smoothed inline ascent on a %s route", (mode) => {
    renderCard({ ...uphill, mode });
    expect(screen.getByTestId("route-ascent")).toHaveTextContent("Ascent +20 m");
    expect(screen.getByRole("radio", { name: /Ascent \+20 m/ })).toBeInTheDocument();
  });

  it("converts ascent to feet in imperial units", () => {
    renderCard({ ...uphill, mode: "cycling" }, "imperial");
    expect(screen.getByTestId("route-ascent")).toHaveTextContent("Ascent +66 ft");
  });

  it("localizes the ascent label in German", () => {
    renderCard({ ...uphill, mode: "walking" }, "metric", "de");
    expect(screen.getByTestId("route-ascent")).toHaveTextContent("Anstieg +20 m");
  });

  it("shows known zero ascent for a flat sampled route", () => {
    renderCard({ ...uphill, mode: "walking", elevation: [100, 100, 100] });
    expect(screen.getByTestId("route-ascent")).toHaveTextContent("Ascent +0 m");
  });

  const unusableProfiles: Array<{ name: string; elevation: number[] | undefined }> = [
    { name: "missing", elevation: undefined },
    { name: "empty", elevation: [] },
    { name: "single-sample", elevation: [100] },
  ];

  it.each(unusableProfiles)("omits ascent for a $name profile", ({ elevation }) => {
    renderCard({ ...uphill, mode: "walking", elevation });
    expect(screen.queryByTestId("route-ascent")).toBeNull();
  });

  it.each(["driving", "motorcycle"] as const)(
    "does not show inline ascent for %s routes",
    (mode) => {
      renderCard({ ...uphill, mode });
      expect(screen.queryByTestId("route-ascent")).toBeNull();
    },
  );
});

describe("RouteCard arrival time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderArrival = (
    arrivalContext: React.ComponentProps<typeof RouteCard>["arrivalContext"],
  ) =>
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={{ ...baseRoute, duration: 5400 }}
          index={0}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          arrivalContext={arrivalContext}
        />
      </NextIntlClientProvider>,
    );

  it("shows an estimated arrival from the current time for depart-now driving", () => {
    renderArrival({ kind: "now", destinationTimeZone: "Europe/Berlin" });
    const arrival = screen.getByTestId("route-arrival");
    expect(arrival).toHaveTextContent(/Arrives.*1:30\s*PM/);
    expect(screen.getByRole("radio").getAttribute("aria-describedby")?.split(" ")).toContain(
      arrival.id,
    );
  });

  it("resolves a chosen departure in the origin zone before displaying destination time", () => {
    renderArrival({
      kind: "departAt",
      wallClock: "2026-07-04T09:30",
      originTimeZone: "America/New_York",
      destinationTimeZone: "Europe/Berlin",
    });
    expect(screen.getByTestId("route-arrival")).toHaveTextContent(/Arrives.*5:00\s*PM/);
    expect(screen.getByTestId("route-arrival")).not.toHaveTextContent("UTC+2");
  });

  it("labels an arrive-by request as a deadline instead of an exact ETA", () => {
    renderArrival({
      kind: "arriveBy",
      wallClock: "2026-07-04T18:00",
      destinationTimeZone: "Europe/Berlin",
    });
    expect(screen.getByTestId("route-arrival")).toHaveTextContent(/Arrive by.*6:00\s*PM/);
    expect(screen.getByTestId("route-arrival")).not.toHaveTextContent("Arrives");
  });

  it("uses a resolved scheduled arrival instead of adding duration to the deadline", () => {
    renderArrival({
      kind: "scheduled",
      arrival: "2026-07-04T17:00:00+02:00",
      destinationTimeZone: "Europe/Berlin",
    });
    expect(screen.getByTestId("route-arrival")).toHaveTextContent(/Arrives.*5:00\s*PM/);
  });

  it("does not invent an arrival when there is no time context", () => {
    renderCard(baseRoute);
    expect(screen.queryByTestId("route-arrival")).toBeNull();
  });
});

describe("RouteCard local access", () => {
  it.each([
    ["en", "Uses a road closed except for local access"],
    ["de", "Nutzt eine gesperrte Straße (Anlieger frei)"],
  ] as const)("says in %s when the route uses a road open only to local access", (locale, text) => {
    renderCard({ ...baseRoute, usesLocalAccessRoad: true }, "metric", locale);
    expect(screen.getByTestId("local-access-route-status").textContent).toBe(text);
  });

  it("says nothing for a route that uses none", () => {
    renderCard(baseRoute);
    expect(screen.queryByTestId("local-access-route-status")).toBeNull();
  });
});

describe("RouteCard road-condition context", () => {
  const notices: Array<{
    availability: RoadConditionRouteImpact["availability"];
    reasons: string[];
    en: string;
    de: string;
  }> = [
    {
      availability: "limited",
      reasons: ["legacy_geometry_unverified"],
      en: "Reported road conditions nearby may not be reflected in this route",
      de: "Gemeldete Straßenbedingungen in der Nähe sind in dieser Route möglicherweise nicht berücksichtigt",
    },
    {
      availability: "unsupported",
      reasons: ["missing_routing_evidence"],
      en: "Reported road conditions nearby may not be reflected in this route",
      de: "Gemeldete Straßenbedingungen in der Nähe sind in dieser Route möglicherweise nicht berücksichtigt",
    },
    {
      availability: "unavailable",
      reasons: ["road_condition_provider_unavailable"],
      en: "Couldn't check road conditions for this route",
      de: "Straßenbedingungen für diese Route konnten nicht geprüft werden",
    },
    {
      availability: "expired",
      reasons: ["evidence_expired"],
      en: "Road conditions may have changed since this route was planned",
      de: "Die Straßenbedingungen können sich seit der Routenplanung geändert haben",
    },
  ];

  function renderWithImpact(impact: RoadConditionRouteImpact, locale: "en" | "de" = "en") {
    return render(
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "en" ? en : de}
        timeZone="Europe/Berlin"
      >
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          roadConditionImpact={impact}
        />
      </NextIntlClientProvider>,
    );
  }

  it.each(notices)(
    "tells the traveller when $availability conditions ($reasons) may affect the route",
    ({ availability, reasons, en: english, de: german }) => {
      const impact: RoadConditionRouteImpact = {
        availability,
        evaluatedAt: "2026-09-12T12:00:00Z",
        validUntil: null,
        reasons,
      };
      const view = renderWithImpact(impact);
      expect(screen.getByTestId("road-condition-route-status")).toHaveTextContent(english);
      view.unmount();
      renderWithImpact(impact, "de");
      expect(screen.getByTestId("road-condition-route-status")).toHaveTextContent(german);
    },
  );

  it.each([
    { availability: "current" as const, reasons: [] },
    { availability: "unavailable" as const, reasons: ["no_road_condition_provider"] },
    { availability: "unavailable" as const, reasons: ["missing_current_evidence"] },
    {
      availability: "unsupported" as const,
      reasons: ["no_road_condition_provider", "unverified_engine_application"],
    },
  ])("stays quiet when nothing reported applies ($availability, $reasons)", (impact) => {
    renderWithImpact({ ...impact, evaluatedAt: "2026-09-12T12:00:00Z", validUntil: null });
    expect(screen.queryByTestId("road-condition-route-status")).toBeNull();
  });

  it("does not imply a road-condition check when no assessment exists", () => {
    renderCard(baseRoute);
    expect(screen.queryByTestId("road-condition-route-status")).toBeNull();
  });
});

describe("RouteCard keyboard actions", () => {
  it("selects an alternative route with its radio without nesting secondary actions", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDetails = vi.fn();
    const view = render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={1}
          active={false}
          onSelect={onSelect}
          onDetails={onDetails}
          units="metric"
          impact={mockDieselImpact}
        />
      </NextIntlClientProvider>,
    );
    const radio = screen.getByRole("radio", { name: /via A46/ });
    expect((radio as HTMLInputElement).checked).toBe(false);
    radio.focus();
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(1);
    await user.click(screen.getByText("via A46"));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector("button button, button input, label button")).toBeNull();
  });

  it("keeps Details and Impact independent of route selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDetails = vi.fn();
    const view = render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={onSelect}
          onDetails={onDetails}
          units="metric"
          impact={mockDieselImpact}
        />
      </NextIntlClientProvider>,
    );
    const details = screen.getByRole("button", { name: "Details" });
    details.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onDetails).toHaveBeenCalledTimes(2);
    await user.click(screen.getByTestId("route-impact-badge"));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(onSelect).not.toHaveBeenCalled();
    expect(view.container.querySelector("button button, button input, label button")).toBeNull();
  });

  it("uses a button to peek at a scheduled route", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          selectionKind="peek"
          onSelect={onSelect}
          onDetails={() => {}}
          units="metric"
        />
      </NextIntlClientProvider>,
    );
    const peek = screen.getByRole("button", { name: /via A46/ });
    peek.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

describe("RouteCard compact traffic explanation", () => {
  it("describes the caveat when keyboard users select a route", () => {
    renderCard(baseRoute);
    const ids = screen.getByRole("radio").getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(ids.map((id) => document.getElementById(id)?.textContent).join(" ")).toContain(
      "Traffic data unavailable",
    );
  });
  it("shows a compact delay and describes it to keyboard users", () => {
    renderCard({ ...baseRoute, duration: 6300, baselineDuration: 3600 });
    expect(screen.getByTestId("traffic-delay")).toHaveTextContent(/^\(\+45 min\)$/);
    expect(screen.queryByText(/baseline/i)).toBeNull();
    expect(screen.queryByText("Traffic data unavailable")).toBeNull();
    const ids = screen.getByRole("radio").getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(ids.map((id) => document.getElementById(id)?.textContent).join(" ")).toContain(
      "+45 min",
    );
  });
  it.each([
    [3960, "light"],
    [4500, "moderate"],
    [5400, "heavy"],
    [7200, "severe"],
  ] as const)(
    "colors the travel time for a %s-second route using the %s delay band",
    (duration, band) => {
      renderCard({ ...baseRoute, duration, baselineDuration: 3600 });
      expect(getComputedStyle(screen.getByRole("heading", { level: 6 })).color).toBe(
        `var(--omx-traffic-${band})`,
      );
    },
  );
  it.each([
    [2640, 2400], // Relative threshold reached, less than five minutes extra.
    [5760, 5400], // More than five minutes extra, below ten percent.
    [3600, 3600], // Same estimate without current traffic speeds.
    [3500, 3600], // Current conditions can be quicker than the comparison.
  ])("does not advertise a significant delay for %s / %s seconds", (duration, baselineDuration) => {
    renderCard({ ...baseRoute, duration, baselineDuration });
    expect(screen.queryByTestId("traffic-delay")).toBeNull();
    expect(screen.getByText("Traffic data unavailable")).toBeInTheDocument();
    expect(getComputedStyle(screen.getByRole("heading", { level: 6 })).color).toBe(
      "rgba(0, 0, 0, 0.87)",
    );
    expect(screen.getByRole("button", { name: "About traffic" })).toBeInTheDocument();
  });
  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not fabricate a delay without a usable comparison (%s)",
    (baselineDuration) => {
      renderCard({ ...baseRoute, baselineDuration });
      expect(screen.queryByTestId("traffic-delay")).toBeNull();
      expect(screen.getByText("Traffic data unavailable")).toBeInTheDocument();
    },
  );
  it.each(["walking", "cycling"] as const)("does not show traffic delays for %s", (mode) => {
    renderCard({ ...baseRoute, mode, duration: 6300, baselineDuration: 3600 });
    expect(screen.queryByTestId("traffic-delay")).toBeNull();
    expect(screen.queryByRole("button", { name: "About traffic" })).toBeNull();
  });
  it("keeps severity coloring on an unselected motorcycle alternative", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <RouteCard
          route={{ ...baseRoute, mode: "motorcycle", duration: 6300, baselineDuration: 3600 }}
          index={1}
          active={false}
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
        />
      </NextIntlClientProvider>,
    );
    expect(getComputedStyle(screen.getByRole("heading", { level: 6 })).color).toBe(
      "var(--omx-traffic-heavy)",
    );
    expect(screen.getByText("(+45 min)")).toBeInTheDocument();
  });
  it("localizes the compact delay in German", () => {
    renderCard({ ...baseRoute, duration: 6300, baselineDuration: 3600 }, "metric", "de");
    expect(screen.getByTestId("traffic-delay")).toHaveTextContent(/^\(\+45 min\)$/);
  });
  it.each(["route", "peek"] as const)(
    "opens and closes traffic info without selecting the %s route",
    (selectionKind) => {
      const onSelect = vi.fn();
      const view = render(
        <NextIntlClientProvider locale="en" messages={en}>
          <RouteCard
            route={baseRoute}
            index={0}
            active
            selectionKind={selectionKind}
            onSelect={onSelect}
            onDetails={() => {}}
            units="metric"
          />
        </NextIntlClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "About traffic" }));
      expect(screen.getByRole("dialog", { name: "About traffic" })).toBeInTheDocument();
      expect(onSelect).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onSelect).not.toHaveBeenCalled();
      expect(view.container.querySelector("button button, button input, label button")).toBeNull();
    },
  );
});

/**
 * Renders a card inside a shell runtime whose bridge answers with `reply`.
 *
 * The provider is the real one — the point of these tests is what actually
 * crosses the bridge, so faking it would test the fake.
 */
function renderInShell(
  reply: (type: string) => unknown | Promise<unknown>,
  onSelect: () => void = () => {},
) {
  const sent: { type: string; payload: unknown }[] = [];
  const handlers = new Map<string, (event: Event) => void>();
  const NONCE = "nonce-abc";

  const scope: Record<string, unknown> = {
    __OPENMAPX_MOBILE_CHANNEL__: { nonce: NONCE },
    addEventListener: (type: string, handler: (event: Event) => void) => {
      handlers.set(type, handler);
    },
    removeEventListener: (type: string) => handlers.delete(type),
    ReactNativeWebView: {
      postMessage: (raw: string) => {
        const message = JSON.parse(raw);
        sent.push({ type: message.type, payload: message.payload });
        void Promise.resolve(reply(message.type)).then((payload) => {
          if (payload === undefined) return;
          handlers.get("openmapx:native")?.({
            detail: {
              protocolVersion: MOBILE_PROTOCOL_MAX,
              type: nativeReplyType(message.type),
              // The envelope schema is strict, so a reply carrying a field it
              // does not name is dropped rather than delivered.
              messageId: `n-${sent.length}`,
              channelNonce: NONCE,
              sentAtMs: 1_700_000_000_000,
              payload: { ...(payload as Record<string, unknown>), forMessageId: message.messageId },
            },
          } as unknown as Event);
        });
      },
    },
  };

  const view = render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <MobileRuntimeProvider webBuildId="web-build-1" scope={scope}>
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={onSelect}
          onDetails={() => {}}
          units="metric"
        />
      </MobileRuntimeProvider>
    </NextIntlClientProvider>,
  );
  // Scoped to this render: earlier tests in the file leave their trees mounted,
  // so a document-wide query finds several Start buttons.
  const start = () => view.getByRole("button", { name: "Start" });
  return { sent, view, start };
}

function nativeReplyType(type: string): string {
  switch (type) {
    case "web.hello":
      return "native.hello";
    case "session.prepare":
      return "session.prepared";
    case "session.start":
      return "session.started";
    default:
      return "snapshot.update";
  }
}

const HELLO_PAYLOAD = {
  shellVersion: "1.0.0",
  shellBuild: "1",
  selectedProtocolVersion: MOBILE_PROTOCOL_MAX,
  minProtocolVersion: MOBILE_PROTOCOL_MIN,
  maxProtocolVersion: MOBILE_PROTOCOL_MAX,
  platform: "ios",
  capabilities: {
    groundNavigation: true,
    transitNavigation: true,
    backgroundLocation: true,
    localNotifications: true,
    speech: true,
  },
  permission: "background",
  locationDriver: "expo",
  activeSession: null,
};

/** Start reads the planned waypoints, so a card with none never starts. */
function seedWaypoints() {
  useDirectionsStore.setState({
    waypoints: [
      { id: "a", query: "A", coords: [6.08, 50.77] },
      { id: "b", query: "B", coords: [6.68, 51.51] },
    ] as never,
  });
}

/**
 * Waits until the shell's hello has been answered and applied.
 *
 * The reply arrives on a microtask after `postMessage`, so a click issued the
 * moment the hello was *sent* would land while the runtime is still negotiating.
 */
async function negotiated(sent: { type: string }[]) {
  await waitFor(() => expect(sent.some((message) => message.type === "web.hello")).toBe(true));
  await act(async () => {
    await Promise.resolve();
  });
}

const startTypes = (sent: { type: string }[]) =>
  sent.map((message) => message.type).filter((type) => type.startsWith("session."));

describe("RouteCard Start under native authority", () => {
  beforeEach(seedWaypoints);
  afterEach(() => {
    setNavigationAuthority("browser");
    useNavigationStore.getState().clearNativeReadModel();
  });

  const compatibleShell = (type: string) => {
    if (type === "web.hello") return HELLO_PAYLOAD;
    if (type === "session.prepare") return { sessionId: "s1", revision: 1 };
    if (type === "session.start") return { sessionId: "s1", revision: 2 };
    return undefined;
  };

  it("prepares and starts natively without writing the browser session", async () => {
    const onSelect = vi.fn();
    const { sent, start } = renderInShell(compatibleShell, onSelect);
    await negotiated(sent);

    fireEvent.click(start());

    await waitFor(() => expect(startTypes(sent)).toEqual(["session.prepare", "session.start"]));
    // The authoritative snapshot is what makes a session visible, so there is no
    // half-started UI to undo if any of this fails.
    expect(useNavigationStore.getState().status).toBe("idle");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("sends the route inside the start package", async () => {
    const { sent, start } = renderInShell(compatibleShell);
    await negotiated(sent);

    fireEvent.click(start());

    await waitFor(() => expect(sent.some((m) => m.type === "session.prepare")).toBe(true));
    const prepare = sent.find((m) => m.type === "session.prepare") as {
      payload: { startPackage: { kind: string; route: { geometry: unknown[] } } };
    };
    expect(prepare.payload.startPackage.kind).toBe("ground");
    expect(prepare.payload.startPackage.route.geometry).toHaveLength(2);
  });

  it("sends one command however fast the button is tapped", async () => {
    const { sent, start } = renderInShell((type) => {
      if (type === "web.hello") return HELLO_PAYLOAD;
      // Never answers prepare, so the first Start is still in flight.
      return undefined;
    });
    await negotiated(sent);

    const button = start();
    fireEvent.click(button);
    await waitFor(() => expect(startTypes(sent)).toEqual(["session.prepare"]));
    fireEvent.click(button);
    fireEvent.click(button);

    expect(startTypes(sent)).toEqual(["session.prepare"]);
  });

  it("says the app is too old rather than starting a browser session", async () => {
    const { sent, start, view } = renderInShell((type) =>
      type === "web.hello" ? { ...HELLO_PAYLOAD, selectedProtocolVersion: null } : undefined,
    );
    await negotiated(sent);

    fireEvent.click(start());

    expect((await view.findByRole("alert")).textContent).toBe(en.navigation.startUpdateRequired);
    expect(startTypes(sent)).toEqual([]);
    expect(useNavigationStore.getState().status).toBe("idle");
  });
});

describe("RouteCard Start under browser authority", () => {
  beforeEach(seedWaypoints);
  afterEach(() => useNavigationStore.getState().stopNavigation());

  it("still starts the browser session directly", async () => {
    const view = renderCard(baseRoute);

    fireEvent.click(view.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(useNavigationStore.getState().status).toBe("navigating"));
  });

  it("carries the route assessment into navigation and shows its limited status", async () => {
    const roadConditionImpact: RoadConditionRouteImpact = {
      availability: "limited",
      evaluatedAt: "2026-09-12T12:00:00Z",
      validUntil: null,
      reasons: ["legacy_geometry_unverified"],
    };
    const view = render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          roadConditionImpact={roadConditionImpact}
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByTestId("road-condition-route-status").textContent).toContain(
      "Reported road conditions nearby may not be reflected in this route",
    );
    fireEvent.click(view.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(useNavigationStore.getState().roadConditionImpact).toEqual(roadConditionImpact),
    );
  });
});

const mockDieselComparison: NonNullable<RouteImpact["comparison"]> = {
  isLowestEmissions: false,
  isLowestCost: false,
  isFastest: true,
  emissionsDeltaGrams: 0,
  emissionsDeltaPct: 0,
  costDelta: 0,
  reason: null,
};

const mockDieselImpact: RouteImpact = {
  routeIndex: 0,
  vehicleId: "v1",
  vehicleName: "VW Golf 2.0 TDI",
  vehiclePowertrain: "diesel",
  occupancy: 1,
  energy: {
    fuelLiters: 4.2,
    electricityKwh: null,
    provenance: {
      kind: "calculated",
      timestamp: "2026-09-03T12:00:00Z",
      calculatedAt: "2026-09-03T12:00:00Z",
      citation: "VW Golf 2.0 TDI (5.2 L/100km)",
      assumptions: [{ kind: "base_fuel_consumption", litersPer100Km: 5.2 }],
    },
  },
  emissions: {
    totalGrams: 8400,
    tailpipeGrams: 7000,
    upstreamGrams: 1400,
    provenance: {
      kind: "defaulted",
      timestamp: "2026-09-03T12:00:00Z",
      calculatedAt: "2026-09-03T12:00:00Z",
      citation: "EEA 2024",
      assumptions: [{ kind: "tailpipe_factor", gramsPerLiter: 2640 }],
    },
  },
  cost: {
    costType: "road",
    currency: "EUR",
    energyCost: 6.8,
    tollStatus: "no_tolls",
    tollCost: null,
    transitFare: null,
    knownCost: 6.8,
    totalCost: 6.8,
    costCompleteness: "complete",
    energyCostProvenance: {
      kind: "provider",
      timestamp: "2026-09-03T12:00:00Z",
      calculatedAt: "2026-09-03T12:00:00Z",
      citation: "Tankerkönig DE",
      assumptions: [{ kind: "unit_price", value: 1.62, currency: "EUR" }],
    },
  },
  comparison: mockDieselComparison,
};

const mockVehicles: PersonalVehicle[] = [
  {
    id: "v1",
    name: "VW Golf 2.0 TDI",
    kind: "car",
    powertrain: "diesel",
    isDefault: true,
    presetId: null,
    ev: null,
    fuelConsumptionLPer100Km: 5.2,
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
  },
];

describe("RouteCard impact integration", () => {
  it("renders RouteImpactBadge when impact prop is provided", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          impact={mockDieselImpact}
        />
      </NextIntlClientProvider>,
    );

    const badge = screen.getByTestId("route-impact-badge");
    expect(badge).toBeDefined();
    // Displays vehicle-aware emissions and cost instead of static 170 g/km estimate
    expect(badge.textContent).toContain("8.4 kg CO₂");
    expect(badge.textContent).toContain("~€6.80");
    // Ensure static ~20 kg CO2 is not rendered
    expect(screen.queryByText(/20\.1 kg CO₂/)).toBeNull();
  });

  it("displays Eco Choice badge on alternative with lowest emissions", () => {
    const ecoImpact: RouteImpact = {
      ...mockDieselImpact,
      comparison: {
        isLowestEmissions: true,
        isLowestCost: false,
        isFastest: false,
        emissionsDeltaGrams: -500,
        emissionsDeltaPct: -5.9,
        costDelta: 0,
        reason: { kind: "shorter", distanceMeters: 3200 },
      },
    };

    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={1}
          active={false}
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          impact={ecoImpact}
        />
      </NextIntlClientProvider>,
    );

    const ecoChip = screen.getByTestId("eco-choice-chip");
    expect(ecoChip).toBeDefined();
    expect(ecoChip.textContent).toBe("Eco Choice");
  });

  it("tapping the impact badge opens RouteImpactDetailsDialog", async () => {
    const handleUpdateAssumptions = vi.fn();

    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          impact={mockDieselImpact}
          vehicles={mockVehicles}
          onUpdateAssumptions={handleUpdateAssumptions}
        />
      </NextIntlClientProvider>,
    );

    // Dialog is initially closed
    expect(screen.queryByRole("dialog")).toBeNull();

    // Tap badge
    fireEvent.click(screen.getByTestId("route-impact-badge"));

    // Dialog is now open
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Route Impact")).toBeDefined();
    expect(screen.getByTestId("dialog-vehicle-name").textContent).toBe("VW Golf 2.0 TDI");

    // Close dialog
    fireEvent.click(screen.getByTestId("dialog-close-button"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("falls back to legacy estimateDrivingCo2Grams when impact is omitted", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
        />
      </NextIntlClientProvider>,
    );

    expect(screen.queryByTestId("route-impact-badge")).toBeNull();
    // 118.132 km * 170 g/km = 20082 g = 20.1 kg CO2
    expect(screen.getByText(/20\.1 kg CO₂/)).toBeDefined();
  });

  it("explains why a plug-in hybrid estimate is unavailable", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          impactUnavailableReason="plugin_hybrid_inputs_missing"
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText("Impact estimate unavailable for plug-in hybrids")).toBeDefined();
    expect(screen.queryByText(/20\.1 kg CO₂/)).toBeNull();
  });

  it("explains why an unknown motorized powertrain cannot be estimated", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          impactUnavailableReason="unsupported_powertrain"
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText("Impact estimate unavailable for this powertrain")).toBeDefined();
    expect(screen.queryByText(/20\.1 kg CO₂/)).toBeNull();
  });

  it("uses the calculated fastest route instead of assuming index zero", () => {
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          impact={{
            ...mockDieselImpact,
            comparison: { ...mockDieselComparison, isFastest: false },
          }}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText("Fastest route")).toBeNull();

    rerender(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={1}
          active
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          impact={{
            ...mockDieselImpact,
            comparison: { ...mockDieselComparison, isFastest: true },
          }}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Fastest route")).toBeDefined();
  });

  it("uses route timing when an impact estimate is unavailable", () => {
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={0}
          active
          isFastest={false}
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          impactUnavailableReason="plugin_hybrid_inputs_missing"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText("Fastest route")).toBeNull();

    rerender(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RouteCard
          route={baseRoute}
          index={1}
          active
          isFastest
          onSelect={() => {}}
          onDetails={() => {}}
          units="metric"
          impactUnavailableReason="plugin_hybrid_inputs_missing"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("Fastest route")).toBeDefined();
  });
});

describe("RouteCard current congestion coverage", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const freshCoverage = {
    complete: true,
    evaluatedAt: "2026-10-07T11:59:59Z",
    validUntil: "2026-10-07T12:00:30Z",
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it.each([3600, 3500, 3840, 3899])(
    "uses green without a hint for a fresh %s-second comparison",
    (duration) => {
      renderCard({
        ...baseRoute,
        duration,
        baselineDuration: 3600,
        trafficCoverage: freshCoverage,
      });
      expect(getComputedStyle(screen.getByRole("heading", { level: 6 })).color).toBe(
        "var(--omx-brand)",
      );
      expect(screen.queryByTestId("route-traffic-status")).toBeNull();
      expect(screen.queryByTestId("traffic-delay")).toBeNull();
      const describedBy = screen.getByRole("radio").getAttribute("aria-describedby");
      expect(describedBy).toBeNull();
    },
  );

  it.each([
    undefined,
    { ...freshCoverage, complete: false },
    { ...freshCoverage, evaluatedAt: "2026-10-07T12:00:01Z" },
    { ...freshCoverage, validUntil: "2026-10-07T12:00:00Z" },
    { ...freshCoverage, validUntil: "invalid" },
    { ...freshCoverage, evaluatedAt: "invalid" },
    { ...freshCoverage, validUntil: "2026-10-07T12:05:00Z" },
  ])("does not turn a zero delay green with insufficient evidence (%j)", (trafficCoverage) => {
    renderCard({ ...baseRoute, duration: 3600, baselineDuration: 3600, trafficCoverage });
    expect(getComputedStyle(screen.getByRole("heading", { level: 6 })).color).toBe(
      "rgba(0, 0, 0, 0.87)",
    );
    expect(screen.getByText("Traffic data unavailable")).toBeInTheDocument();
  });

  it("expires green and updates both the duration and its accessible note", () => {
    renderCard({
      ...baseRoute,
      duration: 3600,
      baselineDuration: 3600,
      trafficCoverage: freshCoverage,
    });
    act(() => vi.advanceTimersByTime(30000));
    expect(getComputedStyle(screen.getByRole("heading", { level: 6 })).color).toBe(
      "rgba(0, 0, 0, 0.87)",
    );
    expect(screen.getByText("Traffic data unavailable")).toBeInTheDocument();
    const id = screen.getByRole("radio").getAttribute("aria-describedby");
    expect(id && document.getElementById(id)).toHaveTextContent("Traffic data unavailable");
  });

  it("rearms freshness expiration when the wall clock moves backwards", () => {
    renderCard({
      ...baseRoute,
      duration: 3600,
      baselineDuration: 3600,
      trafficCoverage: freshCoverage,
    });
    vi.setSystemTime(now - 10000);
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.queryByText("Traffic data unavailable")).toBeNull();
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText("Traffic data unavailable")).toBeInTheDocument();
  });

  it("still requires a usable comparison even with complete fresh coverage", () => {
    renderCard({ ...baseRoute, trafficCoverage: freshCoverage });
    expect(getComputedStyle(screen.getByRole("heading", { level: 6 })).color).toBe(
      "rgba(0, 0, 0, 0.87)",
    );
    expect(screen.getByText("Traffic data unavailable")).toBeInTheDocument();
  });

  it("keeps significant delays colored even with complete coverage", () => {
    renderCard({
      ...baseRoute,
      duration: 6300,
      baselineDuration: 3600,
      trafficCoverage: freshCoverage,
    });
    expect(getComputedStyle(screen.getByRole("heading", { level: 6 })).color).toBe(
      "var(--omx-traffic-heavy)",
    );
    expect(screen.getByTestId("traffic-delay")).toHaveTextContent(/^\(\+45 min\)$/);
    expect(screen.queryByText("Traffic data unavailable")).toBeNull();
  });
});

describe("RouteCard expired congestion estimates", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());
  it("drops the delay color and caption when supplied congestion evidence expires", () => {
    renderCard({
      ...baseRoute,
      duration: 6300,
      baselineDuration: 3600,
      trafficCoverage: {
        complete: true,
        evaluatedAt: "2026-10-07T11:59:59Z",
        validUntil: "2026-10-07T12:00:30Z",
      },
    });
    expect(screen.getByTestId("traffic-delay")).toHaveTextContent(/^\(\+45 min\)$/);
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.queryByTestId("traffic-delay")).toBeNull();
    expect(screen.getByText("Traffic data unavailable")).toBeInTheDocument();
    expect(getComputedStyle(screen.getByRole("heading", { level: 6 })).color).toBe(
      "rgba(0, 0, 0, 0.87)",
    );
  });
});

describe("RouteCard compact traffic header", () => {
  it("shows the parenthesized delay directly in the duration heading", () => {
    renderCard({ ...baseRoute, duration: 6300, baselineDuration: 3600 });
    expect(screen.getByRole("heading", { level: 6 })).toHaveTextContent("1 h 45 min (+45 min)");
    expect(
      screen.getByRole("heading", { level: 6 }).contains(screen.getByTestId("traffic-delay")),
    ).toBe(true);
    expect(screen.getAllByTestId("traffic-delay")).toHaveLength(1);
  });

  it.each(["route", "peek"] as const)(
    "keeps the info button outside the %s selection control",
    (selectionKind) => {
      const onSelect = vi.fn();
      render(
        <NextIntlClientProvider locale="en" messages={en}>
          <RouteCard
            route={baseRoute}
            index={0}
            active
            selectionKind={selectionKind}
            onSelect={onSelect}
            onDetails={() => {}}
            units="metric"
          />
        </NextIntlClientProvider>,
      );
      const button = screen.getByRole("button", { name: "About traffic" });
      expect(button.closest("label")).toBeNull();
      expect(button.parentElement?.closest("button")).toBeNull();
      fireEvent.click(button);
      expect(screen.getByRole("dialog", { name: "About traffic" })).toBeInTheDocument();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );
});
