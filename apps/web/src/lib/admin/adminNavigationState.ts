/** Only public navigation state belongs in URLs. Never add form values or proofs. */
const QUERY_KEYS = new Set([
  "tab",
  "status",
  "page",
  "job",
  "source",
  "returnTo",
  "case",
  "section",
  "q",
  "field",
  "filter",
  "region",
  "service",
  "regionId",
  "snapshotId",
  "domain",
  "attention",
  "enabled",
  "assessment",
  "offset",
  "limit",
  "regionOffset",
]);
export function adminQueryHref(
  pathname: string,
  current: URLSearchParams,
  changes: Record<string, string | null>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of current)
    if (QUERY_KEYS.has(key) && value.length <= 2048) params.set(key, value);
  for (const [key, value] of Object.entries(changes)) {
    if (!QUERY_KEYS.has(key)) continue;
    if (value === null) params.delete(key);
    else if (value.length <= 2048) params.set(key, value);
  }
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}
export const PRIVACY_CASE_SECTIONS = [
  "identity",
  "tasks",
  "decisions",
  "export",
  "events",
] as const;
export type PrivacyCaseSection = (typeof PRIVACY_CASE_SECTIONS)[number];
export function parseAdminCaseSelection(params: Pick<URLSearchParams, "get">): {
  caseId: string | null;
  section: PrivacyCaseSection;
} {
  const id = params.get("case");
  const section = params.get("section");
  return {
    caseId:
      id &&
      id.trim().length > 0 &&
      id.length <= 256 &&
      !Array.from(id).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
        ? id
        : null,
    section: PRIVACY_CASE_SECTIONS.find((value) => value === section) ?? "identity",
  };
}
