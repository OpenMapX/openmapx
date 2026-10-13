import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  captureFieldContributors,
  contributorsForField,
  contributorsForFields,
  contributorsForRecords,
  parseContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { KnowledgeResult } from "../domains/knowledge";

const SCALAR_FIELDS = [
  "description",
  "wikipediaExtract",
  "wikipediaUrl",
  "airport",
  "brand",
  "names",
  "phone",
  "email",
  "website",
  "socials",
  "address",
  "city",
  "countryCode",
] as const;

/** A missing key in an authoritative field map is unknown, never the blended receipt. */
export function knowledgeFieldContributors(result: KnowledgeResult, field: string): Attribution[] {
  return contributorsForField(result, field);
}

/** Merge values and ownership together. Provider failures are excluded by the caller. */
export function mergeKnowledgeResults(results: readonly KnowledgeResult[]): KnowledgeResult {
  const merged: KnowledgeResult = {};
  const fields: Record<string, Attribution[]> = {};
  for (const result of results) {
    for (const field of SCALAR_FIELDS) {
      const value = result[field];
      if (!value || (Array.isArray(value) && value.length === 0) || merged[field]) continue;
      Object.assign(merged, { [field]: value });
      Object.assign(fields, captureFieldContributors(result, field));
      if (field === "address" && result.addressEvidence) {
        merged.addressEvidence = result.addressEvidence;
        Object.assign(fields, captureFieldContributors(result, "addressEvidence"));
      }
      if (field === "wikipediaExtract")
        merged.wikipediaExtractSource = result.wikipediaExtractSource;
    }
    for (const [key, value] of Object.entries(result.externalIds ?? {})) {
      if (!value || merged.externalIds?.[key]) continue;
      merged.externalIds = { ...merged.externalIds, [key]: value };
      fields[`externalIds.${key}`] = knowledgeFieldContributors(result, `externalIds.${key}`);
    }
    for (const field of ["photos", "facts"] as const) {
      const items = result[field];
      if (!items?.length) continue;
      const copied = items.map((item) => ({
        ...item,
        ...(item.contributors === undefined
          ? {}
          : { contributors: snapshotContributors(item.contributors) }),
      }));
      Object.assign(merged, { [field]: [...(merged[field] ?? []), ...copied] });
    }
    // Lineage remains diagnostic. It is deliberately separate from display receipts.
    if (result.provenance?.length) {
      const known = new Set((merged.provenance ?? []).map((source) => JSON.stringify(source)));
      merged.provenance = [...(merged.provenance ?? [])];
      for (const source of result.provenance) {
        if (!known.has(JSON.stringify(source))) {
          known.add(JSON.stringify(source));
          merged.provenance.push({ ...source });
        }
      }
    }
  }
  if (Object.keys(fields).length || merged.photos?.length || merged.facts?.length) {
    merged.fieldContributors = fields;
    merged.contributors = snapshotContributors(
      contributorsForFields(fields, Object.keys(fields)),
      contributorsForRecords(merged.photos ?? []),
      contributorsForRecords(merged.facts ?? []),
    );
  }
  return merged;
}

/** Trusted adapters may certify a uniform supplier for their scalar/fact output.
 * Photos require their own file receipt and are never covered by that certificate.
 */
export function captureKnowledgeResult(
  result: KnowledgeResult,
  uniform: readonly Attribution[],
  overrides: Readonly<Record<string, readonly Attribution[]>> = {},
): KnowledgeResult {
  const fields: Record<string, Attribution[]> = {};
  const receipt = (field: string) => {
    if (result.fieldContributors !== undefined || result.contributors !== undefined) {
      return knowledgeFieldContributors(result, field);
    }
    return snapshotContributors(overrides[field] ?? uniform);
  };
  for (const field of SCALAR_FIELDS) {
    if (result[field]) {
      Object.assign(
        fields,
        result.fieldContributors !== undefined || result.contributors !== undefined
          ? captureFieldContributors(result, field)
          : { [field]: receipt(field) },
      );
      if (field === "address" && result.addressEvidence) {
        Object.assign(
          fields,
          result.fieldContributors !== undefined || result.contributors !== undefined
            ? captureFieldContributors(result, "addressEvidence")
            : { addressEvidence: receipt("addressEvidence") },
        );
      }
    }
  }
  for (const key of Object.keys(result.externalIds ?? {})) {
    fields[`externalIds.${key}`] = receipt(`externalIds.${key}`);
  }
  const facts = result.facts?.map((fact) => ({
    ...fact,
    contributors: snapshotContributors(
      parseContributors(fact.contributors) ??
        (result.fieldContributors !== undefined || result.contributors !== undefined
          ? contributorsForField(result, "facts")
          : uniform),
    ),
  }));
  return mergeKnowledgeResults([
    { ...result, ...(facts ? { facts } : {}), fieldContributors: fields },
  ]);
}
