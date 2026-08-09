import { isIP } from "node:net";
import { domainToASCII } from "node:url";

type TimelinePrivateHostsEnv = Record<string, string | undefined>;

function normalizeHostnamePattern(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  const wildcard = value.startsWith("*.");
  const hostname = wildcard ? value.slice(2) : value;
  if (
    !hostname ||
    value === "*" ||
    hostname.includes("*") ||
    /[\s/@:?#\\]/.test(hostname) ||
    hostname.includes("..") ||
    isIP(hostname) !== 0
  ) {
    throw new Error("OPENMAPX_DAWARICH_PRIVATE_HOSTS contains an invalid hostname pattern");
  }
  const ascii = domainToASCII(hostname);
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii
      .split(".")
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  ) {
    throw new Error("OPENMAPX_DAWARICH_PRIVATE_HOSTS contains an invalid hostname pattern");
  }
  return wildcard ? `*.${ascii}` : ascii;
}

export function timelinePrivateHostAllowlist(env: TimelinePrivateHostsEnv = process.env): string[] {
  const raw = env.OPENMAPX_DAWARICH_PRIVATE_HOSTS?.trim();
  if (!raw) return [];
  const normalized = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeHostnamePattern);
  return [...new Set(normalized)];
}
