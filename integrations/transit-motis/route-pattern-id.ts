const ROUTE_PATTERN_PREFIX = "ms:rp:";
const LINE_REFERENCE_PREFIX = "ms:ln:";
const MAX_ENCODED_PAYLOAD_LENGTH = 4096;
const MAX_DECODED_PAYLOAD_LENGTH = 3072;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type MotisRoutePatternIdV1 = {
  v: 1;
  e: string;
  i: number;
  r: string[];
};

export type MotisLineReferenceV1 = {
  v: 1;
  e: string;
  r: string;
};

function encodePayload(payload: MotisRoutePatternIdV1 | MotisLineReferenceV1): string {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > MAX_DECODED_PAYLOAD_LENGTH) {
    throw new RangeError("MOTIS identifier payload is too long");
  }
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  if (encoded.length > MAX_ENCODED_PAYLOAD_LENGTH) {
    throw new RangeError("MOTIS identifier payload is too long");
  }
  return encoded;
}

function decodePayload(id: string, prefix: string): unknown | null {
  if (!id.startsWith(prefix)) return null;
  const encoded = id.slice(prefix.length);
  if (
    encoded.length === 0 ||
    encoded.length > MAX_ENCODED_PAYLOAD_LENGTH ||
    !BASE64URL_PATTERN.test(encoded)
  ) {
    return null;
  }
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.byteLength > MAX_DECODED_PAYLOAD_LENGTH) return null;
    if (bytes.toString("base64url") !== encoded) return null;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function encodeMotisRoutePatternId(
  epoch: string,
  routeIdx: number,
  sourceRouteIds: string[],
): string {
  if (!epoch || !Number.isInteger(routeIdx) || routeIdx < 0 || !sourceRouteIds.every(isString)) {
    throw new TypeError("Invalid MOTIS route-pattern identifier fields");
  }
  return `${ROUTE_PATTERN_PREFIX}${encodePayload({ v: 1, e: epoch, i: routeIdx, r: sourceRouteIds })}`;
}

export function decodeMotisRoutePatternId(id: string): MotisRoutePatternIdV1 | null {
  const value = decodePayload(id, ROUTE_PATTERN_PREFIX);
  if (!isRecord(value) || !hasExactKeys(value, ["v", "e", "i", "r"])) return null;
  if (
    value.v !== 1 ||
    typeof value.e !== "string" ||
    value.e.length === 0 ||
    !Number.isInteger(value.i) ||
    (value.i as number) < 0 ||
    !Array.isArray(value.r) ||
    !value.r.every(isString)
  ) {
    return null;
  }
  return value as MotisRoutePatternIdV1;
}

export function encodeMotisLineReference(epoch: string, sourceRouteId: string): string {
  if (!epoch || typeof sourceRouteId !== "string") {
    throw new TypeError("Invalid MOTIS line reference fields");
  }
  return `${LINE_REFERENCE_PREFIX}${encodePayload({ v: 1, e: epoch, r: sourceRouteId })}`;
}

export function decodeMotisLineReference(id: string): MotisLineReferenceV1 | null {
  const value = decodePayload(id, LINE_REFERENCE_PREFIX);
  if (!isRecord(value) || !hasExactKeys(value, ["v", "e", "r"])) return null;
  if (value.v !== 1 || typeof value.e !== "string" || value.e.length === 0 || !isString(value.r)) {
    return null;
  }
  return value as MotisLineReferenceV1;
}

export function validateMotisRoutePatternEpoch(
  id: string,
  activeEpoch: string,
): MotisRoutePatternIdV1 | null {
  const decoded = decodeMotisRoutePatternId(id);
  return decoded?.e === activeEpoch ? decoded : null;
}

export function validateMotisLineReferenceEpoch(
  id: string,
  activeEpoch: string,
): MotisLineReferenceV1 | null {
  const decoded = decodeMotisLineReference(id);
  return decoded?.e === activeEpoch ? decoded : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
