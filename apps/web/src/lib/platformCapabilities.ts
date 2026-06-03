export type Capability = "geolocation" | "wakeLock" | "deviceOrientation" | "speech" | "vibrate";

/** Feature-detect a browser capability; safe to call during SSR (returns false). */
export function hasCapability(cap: Capability): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  switch (cap) {
    case "geolocation":
      return "geolocation" in navigator;
    case "wakeLock":
      return "wakeLock" in navigator;
    case "deviceOrientation":
      return "DeviceOrientationEvent" in window;
    case "speech":
      return "speechSynthesis" in window;
    case "vibrate":
      return typeof navigator.vibrate === "function";
    default:
      return false;
  }
}
