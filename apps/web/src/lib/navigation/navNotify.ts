/**
 * Background get-off alarm helpers. During transit navigation the app may be
 * backgrounded / the screen locked; a system notification (via the service
 * worker, the reliable background path) plus a short attention tone wakes the
 * rider before their stop. All feature-detected and best-effort — safe in SSR,
 * tests, and browsers without the APIs.
 */

/** Request notification permission (call from a user gesture, e.g. Start). */
export async function ensureNotificationPermission(): Promise<void> {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission();
  } catch {
    /* best-effort */
  }
}

/** Show the "get off" notification, preferring the SW so it shows in background. */
export async function notifyGetOff(title: string, body: string): Promise<void> {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const options: NotificationOptions & { vibrate?: number[]; renotify?: boolean } = {
      body,
      tag: "omx-alight",
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 150, 300],
    };
    const reg = await navigator.serviceWorker?.ready;
    if (reg?.showNotification) {
      await reg.showNotification(title, options);
      return;
    }
    // Fallback when there's no SW registration (still shows while foregrounded).
    new Notification(title, options);
  } catch {
    /* best-effort */
  }
}

/** A short two-tone chime for the get-off moment (foreground salience). */
export function playAlarmTone(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const start = ctx.currentTime;
    [880, 1175, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = start + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.17);
    });
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 900);
  } catch {
    /* best-effort */
  }
}
