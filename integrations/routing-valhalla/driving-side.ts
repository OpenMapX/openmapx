/**
 * Countries and territories where traffic keeps to the left, by ISO 3166-1
 * alpha-2 code. From Wikipedia's "Left- and right-hand traffic" table and its
 * notes (November 2026): the 67 entries marked LHT, plus the dependencies the
 * notes name (Anguilla, Montserrat, Saint Helena with Ascension and Tristan da
 * Cunha, the Cook Islands, Niue) and the other Australian and New Zealand
 * territories (Christmas Island, the Cocos Islands, Norfolk Island, Tokelau).
 */
const LEFT_HAND_TRAFFIC: ReadonlySet<string> = new Set([
  // Europe
  "CY",
  "GB",
  "GG",
  "IE",
  "IM",
  "JE",
  "MT",
  // Africa and the Atlantic
  "BW",
  "FK",
  "GS",
  "KE",
  "LS",
  "MU",
  "MW",
  "MZ",
  "NA",
  "SC",
  "SH",
  "SZ",
  "TZ",
  "UG",
  "ZA",
  "ZM",
  "ZW",
  // Asia
  "BD",
  "BN",
  "BT",
  "HK",
  "ID",
  "IN",
  "JP",
  "LK",
  "MO",
  "MV",
  "MY",
  "NP",
  "PK",
  "SG",
  "TH",
  "TL",
  // Oceania
  "AU",
  "CC",
  "CK",
  "CX",
  "FJ",
  "KI",
  "NF",
  "NR",
  "NU",
  "NZ",
  "PG",
  "PN",
  "SB",
  "TK",
  "TO",
  "TV",
  "WS",
  // The Americas
  "AG",
  "AI",
  "BB",
  "BM",
  "BS",
  "DM",
  "GD",
  "GY",
  "JM",
  "KN",
  "KY",
  "LC",
  "MS",
  "SR",
  "TC",
  "TT",
  "VC",
  "VG",
  "VI",
]);

/** The side traffic keeps to in a country; undefined without a country code. */
export function drivingSideIn(countryCode: string | undefined): "left" | "right" | undefined {
  const code = countryCode?.trim().toUpperCase();
  if (!code) return undefined;
  return LEFT_HAND_TRAFFIC.has(code) ? "left" : "right";
}
