"use client";

import { useMobileRuntimeContext } from "./MobileRuntimeProvider";

/**
 * The typed consumer hook.
 *
 * Deliberately exposes no `postMessage` and no client method that takes a raw
 * type string. A component that could send an arbitrary bridge command would be
 * a component that could be talked into sending one, and the point of the
 * protocol's closed vocabulary is that no such component exists.
 */
export function useMobileRuntime() {
  const runtime = useMobileRuntimeContext();

  return {
    /** Whether the browser may run its own navigation engine. */
    browserAuthority: runtime.browserAuthority,
    /** True from the first render inside the shell, whatever the bridge did. */
    isInstalledShell: runtime.isInstalledShell,
    /** Which browser capabilities the installed shell removes. */
    features: runtime.features,
    state: runtime.state,
    /** What the shell says it can do; null until negotiation completes. */
    capabilities: runtime.handshake?.capabilities ?? null,
    permission: runtime.handshake?.permission ?? null,
    platform: runtime.handshake?.platform ?? null,
    /** The native session as this page understands it. */
    session: runtime.readModel,
  } as const;
}

/**
 * Whether a given navigation mode can actually be started here.
 *
 * In a browser, the browser engine answers for both. In the shell, only a mode
 * the shell has a processor for — claiming otherwise would strand the user on a
 * session nothing can advance.
 */
export function useNavigationModeAvailable(kind: "ground" | "transit"): boolean {
  const runtime = useMobileRuntimeContext();
  if (runtime.browserAuthority) return true;
  if (runtime.state !== "native-compatible") return false;
  const capabilities = runtime.handshake?.capabilities;
  if (!capabilities) return false;
  return kind === "ground" ? capabilities.groundNavigation : capabilities.transitNavigation;
}
