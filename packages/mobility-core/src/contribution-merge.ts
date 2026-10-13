import { type ContributingRecord, snapshotContributors } from "./contributors";

/** Compare retained fields, ignoring provenance and empty metadata containers. */
export function contributionState(record: object, fields: readonly string[]): string {
  const clean = (value: unknown): unknown => {
    if (value === undefined || value === null || value === "") return undefined;
    if (Array.isArray(value)) {
      const items = value.map(clean).filter((item) => item !== undefined);
      return items.length ? items : undefined;
    }
    if (typeof value === "object") {
      const fields = Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([key, field]) => {
          const retained = clean(field);
          return retained === undefined ? [] : [[key, retained]];
        });
      return fields.length ? Object.fromEntries(fields) : undefined;
    }
    return value;
  };
  const values = record as Record<string, unknown>;
  return JSON.stringify(clean(Object.fromEntries(fields.map((field) => [field, values[field]]))));
}

/** Call only when the supplement supplied a retained field or identity. */
export function retainContributions<T extends ContributingRecord & { sources: string[] }>(
  record: T,
  supplement: ContributingRecord & { sources: readonly string[] },
): void {
  record.sources = [...new Set([...record.sources, ...supplement.sources])];
  if (record.contributors !== undefined)
    record.contributors = snapshotContributors(record.contributors, supplement.contributors ?? []);
}
