import type { fetchOsmBoundary } from "@integrations/geocoding/place-lookup";
import type { KnowledgeResult, Place, ReviewAggregate } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  captureFieldContributors,
  contributorsForField,
  contributorsForFields,
  contributorsForRecords,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { pickMoreSpecificWebsite } from "./merge.js";

/** Ownership mirrors the actual enrichment policies, including tag/ID gap fills. */
export function captureEnrichedPlaceContributors(
  base: Place,
  knowledge: KnowledgeResult,
  result: Place,
  reviewStats: Pick<ReviewAggregate, "contributors"> | null,
  adminBoundary: Awaited<ReturnType<typeof fetchOsmBoundary>>,
): Place {
  const fields: Record<string, Attribution[]> = {};
  const metadata = new Set([
    "contributors",
    "fieldContributors",
    "provenance",
    "photos",
    "facts",
    "externalIds",
    "osmTags",
    "ids",
  ]);
  for (const [field, value] of Object.entries(base)) {
    if (value !== undefined && !metadata.has(field))
      Object.assign(fields, captureFieldContributors(base, field));
  }
  const contacts = new Set([
    "phone",
    "email",
    "website",
    "socials",
    "address",
    "addressEvidence",
    "city",
    "countryCode",
  ]);
  for (const [field, value] of Object.entries(knowledge)) {
    if (value !== undefined && !metadata.has(field) && !contacts.has(field)) {
      Object.assign(fields, captureFieldContributors(knowledge, field));
    }
  }
  for (const field of contacts) {
    const key = field as
      | "phone"
      | "email"
      | "website"
      | "socials"
      | "address"
      | "addressEvidence"
      | "city"
      | "countryCode";
    if (!result[key]) continue;
    const baseWins =
      key === "website"
        ? pickMoreSpecificWebsite(base.website, knowledge.website) === base.website &&
          base.website !== undefined
        : key === "address" || key === "addressEvidence"
          ? Boolean(base.address)
          : base[key] !== undefined && base[key] !== null;
    if (key === "addressEvidence") {
      for (const existing of Object.keys(fields)) {
        if (existing === key || existing.startsWith(`${key}.`)) delete fields[existing];
      }
    }
    Object.assign(
      fields,
      captureFieldContributors(
        baseWins ? base : knowledge,
        key === "addressEvidence" ? "address" : key,
        key,
      ),
    );
  }
  for (const [scheme, value] of Object.entries(result.ids)) {
    const key = `ids.${scheme}`;
    if (base.ids[scheme] === value) {
      fields[key] = contributorsForField(base, key);
    } else {
      const externalKey = scheme === "googleMaps" ? "google_maps" : scheme;
      const fromKnowledge = knowledge.externalIds?.[externalKey] === value;
      fields[key] = contributorsForField(
        fromKnowledge ? knowledge : base,
        fromKnowledge ? `externalIds.${externalKey}` : "osmTags",
      );
    }
  }
  for (const [key, value] of Object.entries(result.osmTags ?? {})) {
    const field = `osmTags.${key}`;
    const knowledgeField =
      key === "brand"
        ? "brand.name"
        : key === "brand:wikidata"
          ? "brand.wikidata"
          : key === "email"
            ? "email"
            : "socials";
    fields[field] =
      base.osmTags?.[key] === value
        ? contributorsForField(base, field)
        : contributorsForField(knowledge, knowledgeField);
  }
  fields.osmTags = contributorsForFields(
    fields,
    Object.keys(fields).filter((key) => key.startsWith("osmTags.")),
  );
  fields.ids = contributorsForFields(
    fields,
    Object.keys(fields).filter((key) => key.startsWith("ids.")),
  );
  // Boundary geometry is acquired independently of the resolved place and knowledge.
  fields.boundary = result.boundary ? contributorsForRecords([adminBoundary]) : [];
  fields.boundingBox = result.boundingBox ? contributorsForRecords([adminBoundary]) : [];
  // Ratings are supplied by the review acquisition, independently of the
  // resolved place and knowledge fields. Absence never inherits their receipts.
  fields.rating = contributorsForRecords([reviewStats]);
  fields.reviewCount = contributorsForRecords([reviewStats]);
  return {
    ...result,
    fieldContributors: fields,
    contributors: snapshotContributors(
      contributorsForFields(fields, Object.keys(fields)),
      contributorsForRecords(result.photos ?? []),
      contributorsForRecords(result.facts ?? []),
    ),
  };
}
