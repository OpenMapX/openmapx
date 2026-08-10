"use client";

import { setNavigationAuthority, useNavigationStore } from "@openmapx/core";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DEEPLINK_UPDATE_EVENT } from "@/lib/deepLink";
import { BridgeClient, type HandshakeResult } from "./bridgeClient";
import { isInstalledShell, shellFeatureBoundary } from "./mobileShellEnvironment";
import { applyNativeDeepLink, readNativeDeepLink } from "./nativeDeepLink";
import {
  applyNativeSnapshot,
  envelopeOf,
  forgetEvents,
  type NativeReadModel,
  projectionOf,
  rememberEvent,
} from "./nativeSnapshotReducer";
import { NativeNavigationCommands } from "./navigationCommands";

/**
 * Which of the two runtimes this page is.
 *
 * The distinction that matters is not "is there a shell" but "who owns
 * navigation". Only `browser` permits the browser engine. `negotiating`,
 * `native-incompatible` and `native-error` all mean *no engine here* — they are
 * shell states, not a licence to fall back.
 */
export type MobileRuntimeState =
  | "browser"
  | "negotiating"
  | "native-compatible"
  | "native-incompatible"
  | "native-error";

export interface MobileRuntime {
  state: MobileRuntimeState;
  /** True from the first render inside the shell, whatever the bridge did. */
  isInstalledShell: boolean;
  /** Whether the browser may run its own navigation engine. */
  browserAuthority: boolean;
  features: ReturnType<typeof shellFeatureBoundary>;
  handshake: HandshakeResult | null;
  /** The native session as this page understands it. */
  readModel: NativeReadModel | null;
  client: BridgeClient | null;
  /** The only way to mutate the native session; null in an ordinary browser. */
  commands: NativeNavigationCommands | null;
}

const BROWSER_RUNTIME: MobileRuntime = {
  state: "browser",
  isInstalledShell: false,
  browserAuthority: true,
  features: shellFeatureBoundary({}),
  handshake: null,
  readModel: null,
  client: null,
  commands: null,
};

const MobileRuntimeContext = createContext<MobileRuntime>(BROWSER_RUNTIME);

export interface MobileRuntimeProviderProps {
  children: ReactNode;
  webBuildId: string;
  /** Injected for tests; production reads the real global scope. */
  scope?: unknown;
}

/**
 * Negotiates once per document and keeps the read model in step.
 *
 * The initial state is decided synchronously from the injected descriptor, not
 * from the handshake, because several feature guards read it on the first render
 * and must not see `browser` inside an installed app even for one frame.
 */
export function MobileRuntimeProvider({ children, webBuildId, scope }: MobileRuntimeProviderProps) {
  const inShell = useMemo(() => isInstalledShell(scope ?? globalThis), [scope]);
  const [state, setState] = useState<MobileRuntimeState>(inShell ? "negotiating" : "browser");
  const [handshake, setHandshake] = useState<HandshakeResult | null>(null);
  const [readModel, setReadModel] = useState<NativeReadModel | null>(null);
  const clientRef = useRef<BridgeClient | null>(null);
  const [commands, setCommands] = useState<NativeNavigationCommands | null>(null);

  // Set before any effect runs, and before the handshake has said anything: the
  // browser engine must be refused during negotiation too, not merely once
  // negotiation has failed.
  if (inShell && useNavigationStore.getState().navigationAuthority !== "native") {
    setNavigationAuthority("native");
  }

  useEffect(() => {
    if (!inShell) return;

    const client = new BridgeClient({ webBuildId, scope: scope ?? globalThis });
    clientRef.current = client;
    const nativeCommands = new NativeNavigationCommands(client, () => {
      const store = useNavigationStore.getState();
      return { sessionId: store.nativeSessionId, revision: store.nativeRevision };
    });
    setCommands(nativeCommands);

    if (!client.attach()) {
      // A descriptor with no transport is a broken shell, never a browser.
      setState("native-error");
      return;
    }

    const unsubscribe = client.subscribe((message) => {
      if (message.type === "snapshot.update") {
        const incoming = envelopeOf((message.payload as { snapshot?: unknown }).snapshot);
        if (!incoming) return;
        setReadModel((current) => {
          const outcome = applyNativeSnapshot(current, incoming);
          if (!outcome.ok) {
            // A gap or a changed route means the page is behind; ask for the
            // whole thing rather than render an interpolation.
            if (outcome.reason === "need-full-snapshot") void nativeCommands.requestSnapshot();
            return current;
          }
          // The store re-checks the step against what it actually rendered,
          // which is what catches a batched render dropping one in between.
          const projection = projectionOf(outcome.model, incoming.type);
          const store = useNavigationStore.getState();
          const applied =
            incoming.type === "full"
              ? store.applyNativeFullSnapshot(projection)
              : store.applyNativeDelta(projection);
          if (applied === "needs-full-snapshot") {
            void nativeCommands.requestSnapshot();
            return current;
          }
          return outcome.model;
        });
        return;
      }

      if (message.type === "deep-link.open") {
        const intent = readNativeDeepLink(message.payload);
        if (!intent) return;
        applyNativeDeepLink(intent, {
          replaceSearch: (query) => {
            const url = new URL(window.location.href);
            url.search = query;
            window.history.replaceState(window.history.state, "", url.toString());
          },
          notify: () => window.dispatchEvent(new Event(DEEPLINK_UPDATE_EVENT)),
          // The navigation view mounts itself off store state, so bringing the
          // trip to the front is exactly reconciling with native.
          showActiveNavigation: () => nativeCommands.requestSnapshot(),
          requestSnapshot: () => nativeCommands.requestSnapshot(),
        });
        return;
      }

      if (message.type === "navigation.event") {
        const eventId = (message.payload as { eventId?: string }).eventId;
        if (!eventId) return;
        // A reconnect replays whatever was never acknowledged, so the store
        // decides whether this one has already been rendered.
        const outcome = useNavigationStore
          .getState()
          .applyNativeEvent({ eventId, type: String(message.type) });
        if (outcome !== "applied") return;
        setReadModel((current) => (current ? rememberEvent(current, eventId) : current));
        // Acknowledged immediately: the durable copy lives natively, and leaving
        // it unacknowledged would replay it on every reconnect.
        void nativeCommands.acknowledgeEvents([eventId]);
        setReadModel((current) => (current ? forgetEvents(current, [eventId]) : current));
      }
    });

    let cancelled = false;
    client
      .hello()
      .then((result) => {
        if (cancelled) return;
        setHandshake(result);
        setState(
          result.selectedProtocolVersion === null ? "native-incompatible" : "native-compatible",
        );
        // A session that survived a reload is discovered here, not assumed.
        if (result.activeSession) void nativeCommands.requestSnapshot();
      })
      .catch(() => {
        if (!cancelled) setState("native-error");
      });

    return () => {
      cancelled = true;
      unsubscribe();
      client.close();
      clientRef.current = null;
      setCommands(null);
    };
  }, [inShell, webBuildId, scope]);

  // Reconcile whenever the page could have missed something: returning to the
  // foreground, or coming back online. Native state wins in both directions —
  // the page asks what is true and never uploads its own guess as a recovery.
  useEffect(() => {
    if (!commands || state !== "native-compatible") return;
    const host = (scope ?? globalThis) as {
      addEventListener?: (type: string, handler: () => void) => void;
      removeEventListener?: (type: string, handler: () => void) => void;
      document?: { visibilityState?: string };
    };
    if (typeof host.addEventListener !== "function") return;

    let scheduled = false;
    const reconcile = () => {
      if (host.document && host.document.visibilityState === "hidden") return;
      // Foregrounding and reconnecting usually arrive together; one request is
      // the honest answer to both.
      if (scheduled) return;
      scheduled = true;
      void commands.requestSnapshot().finally(() => {
        scheduled = false;
      });
    };

    host.addEventListener("visibilitychange", reconcile);
    host.addEventListener("online", reconcile);
    return () => {
      host.removeEventListener?.("visibilitychange", reconcile);
      host.removeEventListener?.("online", reconcile);
    };
  }, [commands, state, scope]);

  const value = useMemo<MobileRuntime>(
    () => ({
      state,
      isInstalledShell: inShell,
      browserAuthority: state === "browser",
      features: shellFeatureBoundary(scope ?? globalThis),
      handshake,
      readModel,
      client: clientRef.current,
      commands,
    }),
    [state, inShell, handshake, readModel, scope, commands],
  );

  return <MobileRuntimeContext.Provider value={value}>{children}</MobileRuntimeContext.Provider>;
}

export function useMobileRuntimeContext(): MobileRuntime {
  return useContext(MobileRuntimeContext);
}

export { BROWSER_RUNTIME };
