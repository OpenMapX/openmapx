import { createHash } from "node:crypto";

/** Reviewed implementation contract consumed by the release gate and bound
 * into the source fingerprint. */
export const PRIVACY_BOUNDED_SOURCE_STREAMING_CAPABILITY = Object.freeze({
  version: 1,
  databaseCursor: true,
  encryptedReplaySpool: true,
  perRecordAndMemberBounds: true,
});

export interface StreamFacts {
  bytes: number;
  records: number;
  sha256: string;
}

export interface EncodedRecordStream {
  source: AsyncIterable<Uint8Array>;
  facts: Promise<StreamFacts>;
}

export interface StreamEncodingLimits {
  maxBytes?: number;
  maxRecords?: number;
}

function encode(
  records: AsyncIterable<Record<string, unknown>>,
  framing: { start: string; separator: string; end: string },
  limits: StreamEncodingLimits = {},
): EncodedRecordStream {
  let resolveFacts!: (facts: StreamFacts) => void;
  let rejectFacts!: (error: unknown) => void;
  const facts = new Promise<StreamFacts>((resolve, reject) => {
    resolveFacts = resolve;
    rejectFacts = reject;
  });
  void facts.catch(() => undefined);
  const source = (async function* () {
    const hash = createHash("sha256");
    let bytes = 0;
    let count = 0;
    const emit = (text: string): Buffer => {
      const chunk = Buffer.from(text, "utf8");
      if (bytes + chunk.byteLength > (limits.maxBytes ?? 512 * 1024 * 1024))
        throw new Error("primary source stream byte limit exceeded");
      bytes += chunk.byteLength;
      hash.update(chunk);
      return chunk;
    };
    let complete = false;
    try {
      if (framing.start) yield emit(framing.start);
      for await (const record of records) {
        if (count >= (limits.maxRecords ?? 10_000_000))
          throw new Error("primary source stream record limit exceeded");
        if (count > 0 && framing.separator) yield emit(framing.separator);
        yield emit(JSON.stringify(record));
        count += 1;
      }
      if (framing.end) yield emit(framing.end);
      complete = true;
      resolveFacts({ bytes, records: count, sha256: hash.digest("hex") });
    } catch (error) {
      rejectFacts(error);
      throw error;
    } finally {
      if (!complete) rejectFacts(new Error("primary source stream cancelled"));
    }
  })();
  return { source, facts };
}

export function encodeJsonLines(
  records: AsyncIterable<Record<string, unknown>>,
  limits: StreamEncodingLimits = {},
): EncodedRecordStream {
  return encode(records, { start: "", separator: "\n", end: "\n" }, limits);
}

export function encodeJsonArray(
  records: AsyncIterable<Record<string, unknown>>,
  limits: StreamEncodingLimits = {},
): EncodedRecordStream {
  return encode(records, { start: "[", separator: ",", end: "]\n" }, limits);
}

export function encodeGeoJson(
  records: AsyncIterable<Record<string, unknown>>,
  limits: StreamEncodingLimits = {},
): EncodedRecordStream {
  const features = (async function* () {
    for await (const record of records) {
      const coordinates = record.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length !== 2) continue;
      yield {
        type: "Feature",
        id: record.id,
        geometry: { type: "Point", coordinates },
        properties: Object.fromEntries(
          Object.entries(record).filter(([key]) => key !== "coordinates"),
        ),
      };
    }
  })();
  return encode(
    features,
    {
      start: '{"type":"FeatureCollection","features":[',
      separator: ",",
      end: "]}\n",
    },
    limits,
  );
}
