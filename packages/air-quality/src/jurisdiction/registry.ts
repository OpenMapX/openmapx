import type { AirQualityProgramId, AirQualityStandardId } from "../types";

export interface JurisdictionProgramEntry {
  countryCode: string;
  subdivisionCode: string | null;
  programId: AirQualityProgramId;
  standardId: AirQualityStandardId | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  requiresCommunityMatch: boolean;
  citation: string;
}

const EEA_COUNTRIES = [
  "AL",
  "AT",
  "BA",
  "BE",
  "BG",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "ME",
  "MK",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "RS",
  "SE",
  "SI",
  "SK",
  "TR",
  "XK",
] as const;

export const JURISDICTION_PROGRAM_REGISTRY_REVISION = "air-quality-programs-2026-08-29";

/**
 * Natural Earth represents these US air-quality jurisdictions as dependencies
 * with their own ISO codes. They use the US EPA AQI program and therefore map
 * to US for program selection; UK/Chinese dependencies are intentionally not
 * collapsed because they do not use their sovereign's headline standard.
 */
export const JURISDICTION_BOUNDARY_ALIASES: Readonly<Record<string, string>> = {
  AS: "US",
  GU: "US",
  MP: "US",
  PR: "US",
  VI: "US",
};

const CORE_PROGRAMS: JurisdictionProgramEntry[] = [
  {
    countryCode: "US",
    subdivisionCode: null,
    programId: "us-epa-aqi",
    standardId: "us-epa-2024",
    effectiveFrom: "2024-05-06T00:00:00Z",
    effectiveUntil: null,
    requiresCommunityMatch: false,
    citation: "EPA AQI TAD 2024",
  },
  {
    countryCode: "GB",
    subdivisionCode: null,
    programId: "uk-daqi",
    standardId: "uk-daqi-current",
    effectiveFrom: "2026-04-13T00:00:00Z",
    effectiveUntil: null,
    requiresCommunityMatch: false,
    citation: "GOV.UK DAQI 2026-04-13",
  },
  {
    countryCode: "IN",
    subdivisionCode: null,
    programId: "in-naqi",
    standardId: "in-naqi-current",
    effectiveFrom: "2014-10-17T00:00:00Z",
    effectiveUntil: null,
    requiresCommunityMatch: false,
    citation: "CPCB National AQI technical report",
  },
  {
    countryCode: "CN",
    subdivisionCode: null,
    programId: "cn-hj633",
    standardId: "cn-hj633-2026",
    effectiveFrom: "2026-02-28T16:00:00Z",
    effectiveUntil: null,
    requiresCommunityMatch: false,
    citation: "MEE HJ 633-2026",
  },
  {
    countryCode: "CA",
    subdivisionCode: null,
    programId: "ca-aqhi",
    standardId: "ca-aqhi-current",
    effectiveFrom: "2026-05-28T00:00:00Z",
    effectiveUntil: null,
    requiresCommunityMatch: true,
    citation: "ECCC About the AQHI, reviewed 2026-08-29",
  },
  {
    countryCode: "CA",
    subdivisionCode: "CA-QC",
    programId: "ca-qc-info-smog",
    standardId: null,
    effectiveFrom: "2026-05-28T00:00:00Z",
    effectiveUntil: null,
    requiresCommunityMatch: false,
    citation: "ECCC: Québec uses Info-Smog",
  },
];

export const JURISDICTION_PROGRAMS: readonly JurisdictionProgramEntry[] = CORE_PROGRAMS.concat(
  EEA_COUNTRIES.map(
    (countryCode): JurisdictionProgramEntry => ({
      countryCode,
      subdivisionCode: null,
      programId: "eea-european-aqi",
      standardId: "eu-eea-current",
      effectiveFrom: "2025-07-01T00:00:00Z",
      effectiveUntil: null,
      requiresCommunityMatch: false,
      citation: "EEA European AQI coverage review 2026-08-29",
    }),
  ),
).sort(
  (left, right) =>
    left.countryCode.localeCompare(right.countryCode) ||
    (left.subdivisionCode ?? "").localeCompare(right.subdivisionCode ?? ""),
);

export function resolveProgramEntry(
  countryCode: string,
  subdivisionCode: string | null,
  at: string,
): JurisdictionProgramEntry | null {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) return null;
  return (
    JURISDICTION_PROGRAMS.filter(
      (entry) =>
        entry.countryCode === countryCode &&
        (entry.subdivisionCode === null || entry.subdivisionCode === subdivisionCode),
    )
      .filter(
        (entry) =>
          instant >= Date.parse(entry.effectiveFrom) &&
          (entry.effectiveUntil === null || instant < Date.parse(entry.effectiveUntil)),
      )
      .sort(
        (left, right) =>
          Number(right.subdivisionCode !== null) - Number(left.subdivisionCode !== null),
      )[0] ?? null
  );
}
