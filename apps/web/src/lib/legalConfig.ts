/** Central configuration for all legal pages (Impressum, Privacy Policy, Terms of Service). */
export const legalConfig = {
  name: process.env.LEGAL_NAME ?? "",
  street: process.env.LEGAL_STREET ?? "",
  postalCode: process.env.LEGAL_POSTAL_CODE ?? "",
  city: process.env.LEGAL_CITY ?? "",
  country: process.env.LEGAL_COUNTRY ?? "",
  email: process.env.LEGAL_EMAIL ?? "",
  phone: process.env.LEGAL_PHONE ?? "",
  jurisdictionCity: process.env.LEGAL_JURISDICTION_CITY ?? "",
};

/** Formatted multi-line address block. */
export function formatAddress(cfg = legalConfig) {
  return `${cfg.name}\n${cfg.street}\n${cfg.postalCode} ${cfg.city}\n${cfg.country}`;
}
