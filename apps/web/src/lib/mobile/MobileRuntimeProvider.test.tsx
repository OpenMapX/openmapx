import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

  return { scope, sent, deliver };
}

function helloReply(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    type: "native.hello",
    messageId: "n1",
    channelNonce: NONCE,
    sentAtMs: 1_700_000_000_000,
    payload: {
      shellVersion: "1.0.0",
      shellBuild: "1",
      selectedProtocolVersion: 1,
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
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
      ...overrides,
    },
  };
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
      <span data-testid="bundles">{String(runtime.features.communityFrontendBundles)}</span>
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
  });

  it("changes no browser capability", () => {
    mount({});

    expect(text("bundles")).toBe("true");
    expect(text("microphone")).toBe("true");
  });

  it("allows both navigation modes", () => {
    mount({});

    expect(text("ground")).toBe("true");
    expect(text("transit")).toBe("true");
  });
});

describe("MobileRuntimeProvider inside the shell", () => {
  it("starts negotiating rather than in browser authority", () => {
    // Even one frame of `browser` inside an installed app would let the browser
    // engine and unreviewed bundles start.
    mount(shellScope().scope);

    expect(text("state")).toBe("negotiating");
    expect(text("browser-authority")).toBe("false");
  });

  it("removes the shell-forbidden capabilities on the first render", () => {
    mount(shellScope().scope);

    expect(text("in-shell")).toBe("true");
    expect(text("bundles")).toBe("false");
    expect(text("microphone")).toBe("false");
  });

  it("becomes compatible once the shell answers", async () => {
    const shell = shellScope();
    mount(shell.scope);

    shell.deliver(helloReply());

    await waitFor(() => expect(text("state")).toBe("native-compatible"));
    expect(text("browser-authority")).toBe("false");
  });

  it("reports only the modes the shell actually has a processor for", async () => {
    const shell = shellScope();
    mount(shell.scope);

    shell.deliver(helloReply());

    await waitFor(() => expect(text("ground")).toBe("true"));
    // Claiming transit would strand the rider on a session nothing can advance.
    expect(text("transit")).toBe("false");
  });

  it("reports an old shell as incompatible, never as a browser", async () => {
    const shell = shellScope();
    mount(shell.scope);

    shell.deliver(helloReply({ selectedProtocolVersion: null }));

    await waitFor(() => expect(text("state")).toBe("native-incompatible"));
    expect(text("browser-authority")).toBe("false");
    expect(text("ground")).toBe("false");
  });

  it("reports a shell with no transport as an error, never as a browser", async () => {
    mount(shellScope({ transport: false }).scope);

    await waitFor(() => expect(text("state")).toBe("native-error"));
    expect(text("browser-authority")).toBe("false");
    expect(text("bundles")).toBe("false");
  });

  it("sends the handshake as soon as it mounts", async () => {
    const shell = shellScope();
    mount(shell.scope);

    await waitFor(() => expect(shell.sent).toHaveLength(1));
    expect(JSON.parse(shell.sent[0]).type).toBe("web.hello");
  });
});

describe("MobileRuntimeProvider read model", () => {
  async function negotiated() {
    const shell = shellScope();
    mount(shell.scope);
    shell.deliver(helloReply());
    await waitFor(() => expect(text("state")).toBe("native-compatible"));
    shell.sent.length = 0;
    return shell;
  }

  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    protocolVersion: 1,
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

  it("adopts a full snapshot", async () => {
    const shell = await negotiated();

    shell.deliver(snapshot());

    await waitFor(() => expect(text("revision")).toBe("4"));
  });

  it("applies the next delta", async () => {
    const shell = await negotiated();
    shell.deliver(snapshot());
    await waitFor(() => expect(text("revision")).toBe("4"));

    shell.deliver(snapshot({ type: "progress", revision: 5, kind: undefined }));

    await waitFor(() => expect(text("revision")).toBe("5"));
  });

  it("asks for a full snapshot rather than rendering across a gap", async () => {
    const shell = await negotiated();
    shell.deliver(snapshot());
    await waitFor(() => expect(text("revision")).toBe("4"));
    shell.sent.length = 0;

    shell.deliver(snapshot({ type: "progress", revision: 20, kind: undefined }));

    await waitFor(() => expect(shell.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(shell.sent[0]).type).toBe("snapshot.request");
    // The stale revision is kept until the real answer arrives.
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

    shell.deliver(helloReply({ activeSession: { sessionId: "s1", revision: 12, kind: "ground" } }));

    await waitFor(() => expect(shell.sent.length).toBeGreaterThan(1));
    expect(shell.sent.some((raw) => JSON.parse(raw).type === "snapshot.request")).toBe(true);
  });

  it("acknowledges a navigation event so it is not replayed forever", async () => {
    const shell = await negotiated();
    shell.deliver(snapshot());
    await waitFor(() => expect(text("revision")).toBe("4"));
    shell.sent.length = 0;

    shell.deliver({
      protocolVersion: 1,
      type: "navigation.event",
      messageId: "n-ev",
      channelNonce: NONCE,
      sentAtMs: 1_700_000_000_000,
      payload: { eventId: "e1", event: { type: "off-route" } },
    });

    await waitFor(() => expect(shell.sent.length).toBeGreaterThan(0));
    const acknowledged = shell.sent.map((raw) => JSON.parse(raw));
    expect(acknowledged.some((message) => message.type === "event.ack")).toBe(true);
  });
});
