"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BridgeClient, type HandshakeResult } from "./bridgeClient";
import { isInstalledShell, shellFeatureBoundary } from "./mobileShellEnvironment";
import {
  applyNativeSnapshot,
  envelopeOf,
  forgetEvents,
  type NativeReadModel,
  rememberEvent,
} from "./nativeSnapshotReducer";

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
}

const BROWSER_RUNTIME: MobileRuntime = {
  state: "browser",
  isInstalledShell: false,
  browserAuthority: true,
  features: shellFeatureBoundary({}),
  handshake: null,
  readModel: null,
  client: null,
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

  useEffect(() => {
    if (!inShell) return;

    const client = new BridgeClient({ webBuildId, scope: scope ?? globalThis });
    clientRef.current = client;

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
          if (outcome.ok) return outcome.model;
          // A gap or a changed route means the page is behind; ask for the whole
          // thing rather than render an interpolation.
          if (outcome.reason === "need-full-snapshot") {
            void client.request("snapshot.request", {}).catch(() => undefined);
          }
          return current;
        });
        return;
      }

      if (message.type === "navigation.event") {
        const eventId = (message.payload as { eventId?: string }).eventId;
        if (!eventId) return;
        setReadModel((current) => (current ? rememberEvent(current, eventId) : current));
        // Acknowledged immediately: the durable copy lives natively, and leaving
        // it unacknowledged would replay it on every reconnect.
        void client.request("event.ack", { eventIds: [eventId] }).catch(() => undefined);
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
        if (result.activeSession) {
          void client.request("snapshot.request", {}).catch(() => undefined);
        }
      })
      .catch(() => {
        if (!cancelled) setState("native-error");
      });

    return () => {
      cancelled = true;
      unsubscribe();
      client.close();
      clientRef.current = null;
    };
  }, [inShell, webBuildId, scope]);

  const value = useMemo<MobileRuntime>(
    () => ({
      state,
      isInstalledShell: inShell,
      browserAuthority: state === "browser",
      features: shellFeatureBoundary(scope ?? globalThis),
      handshake,
      readModel,
      client: clientRef.current,
    }),
    [state, inShell, handshake, readModel, scope],
  );

  return <MobileRuntimeContext.Provider value={value}>{children}</MobileRuntimeContext.Provider>;
}

export function useMobileRuntimeContext(): MobileRuntime {
  return useContext(MobileRuntimeContext);
}

export { BROWSER_RUNTIME };
