import type { Attribution, DataSourceAttribution } from "./types/attribution.js";

/** A captured receipt for the fields/identity this record actually supplies. */
export interface ContributingRecord {
  /** Present, including [], is authoritative. Undefined denotes a legacy record. */
  contributors?: readonly Attribution[];
}

export type FieldContributors = Readonly<Record<string, readonly Attribution[]>>;

const STRING_FIELDS = [
  "url",
  "spdxLicense",
  "licenseUrl",
  "attributionText",
  "retrievedAt",
  "notes",
] as const;

/** Validate and copy a portable receipt. Do not carry unrelated provider fields. */
export function parseContributors(value: unknown): Attribution[] | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value)) return undefined;
  const receipts: Attribution[] = [];
  for (const raw of value) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.sourceId !== "string" ||
      !raw.sourceId ||
      typeof raw.name !== "string" ||
      !raw.name
    )
      return undefined;
    const receipt: Attribution = { sourceId: raw.sourceId, name: raw.name };
    for (const field of STRING_FIELDS) {
      if (raw[field] === undefined) continue;
      if (typeof raw[field] !== "string") return undefined;
      receipt[field] = raw[field];
    }
    if (raw.publisher !== undefined) {
      if (
        !raw.publisher ||
        typeof raw.publisher !== "object" ||
        typeof raw.publisher.name !== "string" ||
        (raw.publisher.url !== undefined && typeof raw.publisher.url !== "string")
      )
        return undefined;
      receipt.publisher = {
        name: raw.publisher.name,
        ...(raw.publisher.url === undefined ? {} : { url: raw.publisher.url }),
      };
    }
    receipts.push(receipt);
  }
  return receipts;
}

/** Distinct required wording from the same source must not disappear in a union. */
export function contributorKey(receipt: Attribution): string {
  return JSON.stringify([
    receipt.sourceId,
    receipt.name,
    receipt.url,
    receipt.spdxLicense,
    receipt.licenseUrl,
    receipt.attributionText,
    receipt.publisher?.name,
    receipt.publisher?.url,
    receipt.notes,
  ]);
}

function unionContributors(groups: Iterable<readonly Attribution[]>): Attribution[] {
  const seen = new Set<string>();
  const result: Attribution[] = [];
  for (const group of groups) {
    for (const receipt of parseContributors(group) ?? []) {
      const key = contributorKey(receipt);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(receipt);
    }
  }
  return result;
}

export function snapshotContributors(
  ...groups: readonly (readonly Attribution[])[]
): Attribution[] {
  return unionContributors(groups);
}

/** Union the final displayed records, rather than the original query envelope. */
export function contributorsForRecords(
  records: Iterable<ContributingRecord | null | undefined>,
): Attribution[] {
  return unionContributors(
    (function* () {
      for (const record of records) yield record?.contributors ?? [];
    })(),
  );
}

export function withContributors<T extends object>(
  record: T,
  receipts: readonly Attribution[],
): T & { contributors: Attribution[] } {
  return { ...record, contributors: snapshotContributors(receipts) };
}

export function narrowContributors(
  receipts: readonly Attribution[],
  sourceIds: Iterable<string>,
): Attribution[] {
  const ids = new Set(sourceIds);
  return snapshotContributors(receipts.filter((receipt) => ids.has(receipt.sourceId)));
}

export function serializeContributors(receipts: readonly Attribution[]): string {
  return JSON.stringify(snapshotContributors(receipts));
}

export function withFeatureContributors<T extends { properties?: Record<string, unknown> | null }>(
  feature: T,
  receipts: readonly Attribution[],
): T & { properties: Record<string, unknown> & { _mapAttributions: string } } {
  return {
    ...feature,
    properties: { ...feature.properties, _mapAttributions: serializeContributors(receipts) },
  };
}

/** Explicit compatibility boundary for the older per-record text/url format. */
export function legacyAttributionsToContributors(
  receipts: readonly DataSourceAttribution[],
): Attribution[] {
  return snapshotContributors(
    receipts.map((receipt) => ({
      sourceId: receipt.sourceId ?? (receipt.text || receipt.url),
      name: receipt.text,
      url: receipt.url,
      spdxLicense: receipt.license,
      licenseUrl: receipt.licenseUrl,
    })),
  );
}

/** Capture valid field receipts from a JSON/GeoJSON/MVT metadata map. */
export function parseFieldContributors(value: unknown): FieldContributors | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([field, raw]) => {
      const receipts = parseContributors(raw);
      return receipts === undefined ? [] : [[field, snapshotContributors(receipts)]];
    }),
  );
}

/** Credits the selected display fields, without unioning hidden enrichment. */
export function contributorsForFields(
  fields: FieldContributors | undefined,
  displayedFields: Iterable<string>,
): Attribution[] {
  return contributorsForRecords(
    (function* () {
      for (const field of displayedFields) yield { contributors: fields?.[field] };
    })(),
  );
}
