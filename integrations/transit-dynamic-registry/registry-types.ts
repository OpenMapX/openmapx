import type { BBox } from "@openmapx/core";

export type ProtocolType =
  | "hafasMgate"
  | "hafasQuery"
  | "otpGraphQl"
  | "otpRest"
  | "efa"
  | "trias"
  | "motis";

export interface CoverageTier {
  level: "realtimeCoverage" | "regularCoverage" | "anyCoverage";
  bbox: BBox;
  regions: string[];
}

export interface RegistryEntry {
  id: string; // filename slug: "at/oebb-hafas-mgate"
  slug: string; // short: "oebb"
  prefix: string; // "oebb:"
  name: string; // "ÖBB"
  protocol: ProtocolType;
  supportedLanguages: string[];
  timezone?: string;
  options: Record<string, unknown>;
  coverage: { bbox: BBox; tiers: CoverageTier[] };
  attribution?: { name: string; homepage?: string; license?: string; isProprietary?: boolean };
}
