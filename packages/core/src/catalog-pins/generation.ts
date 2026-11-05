import { createHash } from "node:crypto";
import { canonicalJson } from "../ops/canonical-json";
import {
  catalogPinSetSchema,
  gbfsPinSchema,
  MAX_CATALOG_PIN_BYTES,
  transitousPinSchema,
} from "./schemas";
import type { CatalogPinSet, GbfsCatalogLock, TransitousLock } from "./types";
export function parseCatalogPinSet(value: unknown): CatalogPinSet {
  const pair = catalogPinSetSchema.parse(value),
    { generationId, ...body } = pair;
  if (createHash("sha256").update(canonicalJson(body)).digest("hex") !== generationId)
    throw Error("Catalog pin generation hash mismatch");
  if (Buffer.byteLength(canonicalJson(pair)) > MAX_CATALOG_PIN_BYTES)
    throw Error("Catalog pin generation is too large");
  return pair;
}
export function createCatalogPinSet(
  transitous: TransitousLock,
  gbfs: GbfsCatalogLock,
): CatalogPinSet {
  const body = {
    schemaVersion: 1 as const,
    transitous: transitousPinSchema.parse(transitous),
    gbfs: gbfsPinSchema.parse(gbfs),
  };
  return parseCatalogPinSet({
    ...body,
    generationId: createHash("sha256").update(canonicalJson(body)).digest("hex"),
  });
}
