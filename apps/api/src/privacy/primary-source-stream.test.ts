import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeGeoJson, encodeJsonArray, encodeJsonLines } from "./primary-source-stream.js";

async function consume(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("primary source stream encoders", () => {
  it("encodes deterministic JSONL incrementally with facts", async () => {
    const encoded = encodeJsonLines(
      (async function* () {
        yield { id: "a", value: 1 };
        yield { id: "b", value: 2 };
      })(),
    );
    const bytes = await consume(encoded.source);
    expect(bytes.toString()).toBe('{"id":"a","value":1}\n{"id":"b","value":2}\n');
    await expect(encoded.facts).resolves.toEqual({
      bytes: bytes.byteLength,
      records: 2,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("closes a JSON array without retaining input records", async () => {
    const encoded = encodeJsonArray(
      (async function* () {
        for (let id = 0; id < 10_000; id += 1) yield { id };
      })(),
    );
    const bytes = await consume(encoded.source);
    expect(JSON.parse(bytes.toString())).toHaveLength(10_000);
    await expect(encoded.facts).resolves.toMatchObject({ records: 10_000 });
  });

  it("frames GeoJSON incrementally and omits records without coordinates", async () => {
    const encoded = encodeGeoJson(
      (async function* () {
        yield { id: "a", name: "Home", coordinates: [13, 52] };
        yield { id: "b", name: "No location" };
      })(),
    );
    const bytes = await consume(encoded.source);
    expect(JSON.parse(bytes.toString())).toEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "a",
          geometry: { type: "Point", coordinates: [13, 52] },
          properties: { id: "a", name: "Home" },
        },
      ],
    });
    await expect(encoded.facts).resolves.toMatchObject({ records: 1 });
  });

  it("fails before a record or member can exceed its configured bound", async () => {
    const tooMany = encodeJsonLines(
      (async function* () {
        yield { id: "a" };
        yield { id: "b" };
      })(),
      { maxRecords: 1 },
    );
    await expect(consume(tooMany.source)).rejects.toThrow("record limit");
    await expect(tooMany.facts).rejects.toThrow("record limit");

    const tooLarge = encodeJsonArray(
      (async function* () {
        yield { payload: "too-large" };
      })(),
      { maxBytes: 8 },
    );
    await expect(consume(tooLarge.source)).rejects.toThrow("byte limit");
  });
});
