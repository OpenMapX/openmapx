"use client";

import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISS_KEY = "omx-install-dismissed-at";
const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type InstallPlatform = "android" | "ios" | "none";

interface InstallState {
  deferred: BeforeInstallPromptEvent | null;
  platform: InstallPlatform;
  installed: boolean;
  dismissedAt: number | null;
}

// Module-level singleton — listeners are attached once on first import so the
// `beforeinstallprompt` event (which fires once, very early) is never missed
// because the consuming UI hasn't mounted yet. Hooks subscribe to this state.
const subscribers = new Set<() => void>();
const state: InstallState = {
  deferred: null,
  platform: "none",
  installed: false,
  dismissedAt: null,
};
let bootstrapped = false;

function notify(): void {
  for (const fn of subscribers) fn();
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  if (window.matchMedia?.("(display-mode: window-controls-overlay)").matches) return true;
  // iOS Safari
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function isIos(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  // iPadOS 13+ reports as Mac in UA but has touch points.
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
}

function readDismissedAt(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(DISMISS_KEY);
  if (!raw) return null;
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : null;
}

function bootstrap(): void {
  if (bootstrapped) return;
  if (typeof window === "undefined") return;
  bootstrapped = true;

  state.installed = isStandalone();
  state.platform = isIos() ? "ios" : "none";
  state.dismissedAt = readDismissedAt();

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferred = e as BeforeInstallPromptEvent;
    state.platform = "android";
    notify();
  });

  window.addEventListener("appinstalled", () => {
    state.installed = true;
    state.deferred = null;
    notify();
  });

  // Cross-tab sync — a dismissal in another tab should hide the entry here too.
  window.addEventListener("storage", (e) => {
    if (e.key === DISMISS_KEY) {
      state.dismissedAt = readDismissedAt();
      notify();
    }
  });
}

// Run as soon as the module is parsed on the client. `beforeinstallprompt`
// can fire during page load — earlier than any useEffect would attach a
// listener — so we attach now rather than waiting for a consumer to mount.
bootstrap();

/**
 * Capture install state at app boot. Mounted at the root layout so the
 * module is force-loaded into the client bundle on every route, which is
 * what triggers `bootstrap()` above.
 */
export function InstallPromptCapture(): null {
  return null;
}

export function useInstallPrompt() {
  const [, forceRender] = useState(0);

  useEffect(() => {
    const sub = () => forceRender((n) => n + 1);
    subscribers.add(sub);
    return () => {
      subscribers.delete(sub);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    const deferred = state.deferred;
    if (!deferred) return "unavailable" as const;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    state.deferred = null;
    if (outcome === "dismissed") {
      const now = Date.now();
      window.localStorage.setItem(DISMISS_KEY, String(now));
      state.dismissedAt = now;
    }
    notify();
    return outcome;
  }, []);

  const dismiss = useCallback(() => {
    if (typeof window === "undefined") return;
    const now = Date.now();
    window.localStorage.setItem(DISMISS_KEY, String(now));
    state.dismissedAt = now;
    notify();
  }, []);

  const recentlyDismissed =
    state.dismissedAt !== null && Date.now() - state.dismissedAt < DISMISS_TTL_MS;

  // Whether an install path *exists* right now: Android requires a captured
  // beforeinstallprompt event (without it, prompt() does nothing); iOS only
  // needs the device check.
  const canInstallNow =
    !state.installed &&
    ((state.platform === "android" && state.deferred !== null) || state.platform === "ios");

  // Whether to actually surface the entry to the user — also gates on the
  // dismissal TTL so a user who said "Not now" isn't pestered for two weeks.
  const shouldOfferInstall = canInstallNow && !recentlyDismissed;

  return {
    platform: state.platform,
    installed: state.installed,
    canInstallNow,
    shouldOfferInstall,
    promptInstall,
    dismiss,
  };
}
