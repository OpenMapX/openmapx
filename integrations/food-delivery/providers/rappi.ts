import { withAffiliate } from "../affiliate.js";
import { enc } from "../slug.js";
import type { DeliveryProvider } from "../types.js";

/**
 * Country (ISO-2) → Rappi country TLD. Bare `rappi.com` 302-redirects to a
 * country homepage and DROPS the `?query=`, so the country domain is mandatory.
 */
const RAPPI_TLD: Record<string, string> = {
  mx: "com.mx",
  co: "com.co",
  br: "com.br",
  ar: "com.ar",
  cl: "com.cl",
  pe: "com.pe",
  ec: "com.ec",
  uy: "com.uy",
  cr: "com.cr",
};

export const rappiProvider: DeliveryProvider = {
  id: "rappi",
  name: "Rappi",
  homepage: "https://www.rappi.com/",
  color: "#FE3008",
  fallbackKind: "search",
  regions: ["mx", "co", "br", "ar", "cl", "pe", "ec", "uy", "cr"],
  build(q, config) {
    // Bare `rappi.com` 302s to a country homepage and drops the query — the
    // country TLD is mandatory. `/search?query=` is server-rendered and scopes
    // to the domain's city; city comes from the storefront, so query = name.
    const tld = (q.countryCode && RAPPI_TLD[q.countryCode]) ?? "com.mx";
    return withAffiliate("rappi", `https://www.rappi.${tld}/search?query=${enc(q.name)}`, config);
  },
};
