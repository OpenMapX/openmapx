/**
 * Whether this device can receive the sign-in callback as a verified link.
 *
 * Android delivers a verified App Link to the app through its ordinary link
 * intake. iOS can only match an HTTPS callback inside
 * `ASWebAuthenticationSession` from 17.4; earlier versions accept a custom
 * scheme alone, and any app can register one. There, the system-browser
 * handoff reports itself unavailable rather than fall back to a callback
 * another app could receive.
 */
export function supportsVerifiedAuthCallback(os: string, version: string | number): boolean {
  if (os === "android") return true;
  if (os !== "ios") return false;
  const [major = 0, minor = 0] = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 17 || (major === 17 && minor >= 4);
}
