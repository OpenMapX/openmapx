/**
 * A positive whole number of days, as a string, or "30" for a missing/invalid
 * value. The result is interpolated verbatim into the published privacy text, so
 * a non-numeric env value (e.g. "foo") must not be rendered as a retention claim.
 * Matched as plain decimal digits — `Number()` alone would also accept hex
 * ("0x10" → 16) and exponential ("1e3" → 1000) forms and silently render a value
 * the operator never typed.
 */
function retentionDays(raw: string | undefined): string {
  const trimmed = raw?.trim();
  return trimmed && /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? String(Number(trimmed)) : "30";
}

/** Central configuration for all legal pages (Impressum, Privacy Policy, Terms of Service). */
export const legalConfig = {
  name: process.env.LEGAL_NAME ?? "",
  street: process.env.LEGAL_STREET ?? "",
  postalCode: process.env.LEGAL_POSTAL_CODE ?? "",
  city: process.env.LEGAL_CITY ?? "",
  country: process.env.LEGAL_COUNTRY ?? "",
  email: process.env.LEGAL_EMAIL ?? "",
  phone: process.env.LEGAL_PHONE ?? "",
  // Location-dependent privacy facts. The supervisory authority and hosting
  // provider vary by jurisdiction / hosting setup, so they live in env rather
  // than hardcoded in the privacy page; an empty value omits the corresponding
  // sentence so an unconfigured deployment never renders a dangling fragment.
  // Log retention defaults to the project's standard 30 days.
  supervisoryAuthority: process.env.LEGAL_SUPERVISORY_AUTHORITY ?? "",
  supervisoryAuthorityUrl: process.env.LEGAL_SUPERVISORY_AUTHORITY_URL ?? "",
  hostingProvider: process.env.LEGAL_HOSTING_PROVIDER ?? "",
  hostingLocations: process.env.LEGAL_HOSTING_LOCATIONS ?? "",
  // Validated to a positive integer (not just `|| "30"`) so an empty OR
  // non-numeric env value falls back to "30" instead of rendering e.g.
  // "deleted after  days." / "deleted after foo days." on /privacy.
  serverLogRetentionDays: retentionDays(process.env.LEGAL_SERVER_LOG_RETENTION_DAYS),
};

/** Formatted multi-line address block. */
export function formatAddress(cfg = legalConfig) {
  return `${cfg.name}\n${cfg.street}\n${cfg.postalCode} ${cfg.city}\n${cfg.country}`;
}
