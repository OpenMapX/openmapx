import type { Route } from "@openmapx/core";
import { setNavigationAuthority, useDirectionsStore, useNavigationStore } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MobileRuntimeProvider } from "@/lib/mobile/MobileRuntimeProvider";
import { RouteCard } from "./RouteCard";

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

const renderCard = (route: Route) =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <RouteCard
        route={route}
        index={0}
        active
        onSelect={() => {}}
        onDetails={() => {}}
        units="metric"
      />
    </NextIntlClientProvider>,
  );

describe("RouteCard traffic delta", () => {
  it("shows nothing when there is no baseline duration", () => {
    renderCard(baseRoute);
    expect(screen.queryByTestId("traffic-delay")).toBeNull();
  });

  it("shows nothing when the delay is under five minutes", () => {
    // 4 min on a 40 min baseline: over 10% but under the absolute floor.
    renderCard({ ...baseRoute, duration: 2640, baselineDuration: 2400 });
    expect(screen.queryByTestId("traffic-delay")).toBeNull();
  });

  it("shows nothing when the delay is under ten percent", () => {
    // 6 min on a 90 min baseline: over the absolute floor but under the ratio.
    renderCard({ ...baseRoute, duration: 5760, baselineDuration: 5400 });
    expect(screen.queryByTestId("traffic-delay")).toBeNull();
  });

  it("shows the delay once both thresholds are met", () => {
    // 12 min on a 75 min baseline = 16% -> light band.
    renderCard({ ...baseRoute, duration: 5220, baselineDuration: 4500 });
    const el = screen.getByTestId("traffic-delay");
    expect(el.textContent).toContain("12 min");
    expect(getComputedStyle(el).color).toBe("var(--omx-traffic-light)");
  });

  it("escalates the colour with the delay", () => {
    // 45 min on a 60 min baseline = 75% -> heavy band.
    renderCard({ ...baseRoute, duration: 6300, baselineDuration: 3600 });
    expect(getComputedStyle(screen.getByTestId("traffic-delay")).color).toBe(
      "var(--omx-traffic-heavy)",
    );
  });
});

/**
 * Renders a card inside a shell runtime whose bridge answers with `reply`.
 *
 * The provider is the real one — the point of these tests is what actually
 * crosses the bridge, so faking it would test the fake.
 */
function renderInShell(reply: (type: string) => unknown | Promise<unknown>) {
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
              protocolVersion: 1,
              type: nativeReplyType(message.type),
              // The envelope schema is strict, so a reply carrying a field it
              // does not name is dropped rather than delivered.
              messageId: `n-${sent.length}`,
              channelNonce: NONCE,
              sentAtMs: 1_700_000_000_000,
              payload,
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
          onSelect={() => {}}
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
  selectedProtocolVersion: 1,
  minProtocolVersion: 1,
  maxProtocolVersion: 1,
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
    const { sent, start } = renderInShell(compatibleShell);
    await negotiated(sent);

    fireEvent.click(start());

    await waitFor(() => expect(startTypes(sent)).toEqual(["session.prepare", "session.start"]));
    // The authoritative snapshot is what makes a session visible, so there is no
    // half-started UI to undo if any of this fails.
    expect(useNavigationStore.getState().status).toBe("idle");
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
});
