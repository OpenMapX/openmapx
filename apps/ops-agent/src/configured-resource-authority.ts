/** Same actual resource snapshot used by production registry policy. */
import { createHash } from "node:crypto";

const REGION_ID = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const COUNTRY_ID = /^[A-Z]{2,3}$/;

export interface ConfiguredResourceAuthority {
  revisionId: string;
  regions: ReadonlySet<string>;
  countries: ReadonlySet<string>;
}

function exactConfiguredIds(
  raw: string | undefined,
  pattern: RegExp,
  maximumLength: number,
): string[] {
  const values = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    values.length > 64 ||
    values.some((value) => value.length > maximumLength || !pattern.test(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("Resource authority configuration rejected");
  }
  return values.sort();
}

export function loadConfiguredResourceAuthority(
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredResourceAuthority {
  const regions = exactConfiguredIds(
    env.OPENMAPX_ALLOWED_REGIONS ?? "europe/germany",
    REGION_ID,
    128,
  );
  const countries = exactConfiguredIds(env.OPENMAPX_ALLOWED_COUNTRIES ?? "DE", COUNTRY_ID, 3);
  const digest = createHash("sha256")
    .update("openmapx-resource-authority-v1\0")
    .update(JSON.stringify({ regions, countries }))
    .digest("hex");
  return {
    revisionId: `resources-${digest}`,
    regions: new Set(regions),
    countries: new Set(countries),
  };
}

export function configurationPolicyRevision(
  configurationAuthorityRevision: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${configurationAuthorityRevision.slice(0, 48)}-${loadConfiguredResourceAuthority(env).revisionId}`;
}
