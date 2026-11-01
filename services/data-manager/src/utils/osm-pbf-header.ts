import { closeSync, openSync, readSync } from "node:fs";
import { inflateSync } from "node:zlib";

/**
 * What an OSM PBF's header block says about the data in it. Geofabrik and the
 * planet dumps write the replication timestamp (the moment the data is
 * current to) and the base URL of the diff feed that continues it.
 */
export interface OsmPbfHeader {
  /** ISO time the data is current to (`osmosis_replication_timestamp`). */
  timestamp?: string;
  /** The diff feed that continues this file (`osmosis_replication_base_url`), https only. */
  replicationUrl?: string;
}

/** The format caps a BlobHeader at 64 KiB. */
const MAX_BLOB_HEADER_BYTES = 64 * 1024;
/** A header block is a few hundred bytes; anything far larger is not one. */
const MAX_HEADER_BLOB_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 2048;

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_BYTES = 2;
const WIRE_32BIT = 5;

interface Field {
  number: number;
  value: number | Uint8Array;
}

/** The fields of one protobuf message; a malformed message throws. */
function* fields(bytes: Uint8Array): Generator<Field> {
  let offset = 0;
  const varint = (): number => {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i += 1) {
      if (offset >= bytes.length) throw new Error("truncated varint");
      const byte = bytes[offset++] as number;
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) throw new Error("varint out of range");
        return result;
      }
      scale *= 128;
    }
    throw new Error("varint too long");
  };
  const skip = (count: number): Uint8Array => {
    if (count < 0 || offset + count > bytes.length) throw new Error("truncated field");
    const slice = bytes.subarray(offset, offset + count);
    offset += count;
    return slice;
  };
  while (offset < bytes.length) {
    const key = varint();
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === WIRE_VARINT) yield { number, value: varint() };
    else if (wire === WIRE_BYTES) yield { number, value: skip(varint()) };
    else if (wire === WIRE_64BIT) skip(8);
    else if (wire === WIRE_32BIT) skip(4);
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

function readPrefix(path: string, length: number, position: number): Buffer {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(descriptor, buffer, read, length - read, position + read);
      if (count === 0) throw new Error("file ends inside the header block");
      read += count;
    }
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function text(value: number | Uint8Array): string | undefined {
  return value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;
}

function httpsUrl(value: string | undefined): string | undefined {
  if (!value || value.length > MAX_URL_LENGTH) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The header block's bytes from its Blob: stored raw or zlib-compressed. */
function headerBlockBytes(blob: Uint8Array): Uint8Array {
  let raw: Uint8Array | undefined;
  let zlib: Uint8Array | undefined;
  let rawSize: number | undefined;
  for (const field of fields(blob)) {
    if (field.number === 1 && field.value instanceof Uint8Array) raw = field.value;
    else if (field.number === 2 && typeof field.value === "number") rawSize = field.value;
    else if (field.number === 3 && field.value instanceof Uint8Array) zlib = field.value;
  }
  if (raw) return raw;
  if (zlib && rawSize !== undefined && rawSize <= MAX_HEADER_BLOB_BYTES) {
    return inflateSync(zlib, { maxOutputLength: MAX_HEADER_BLOB_BYTES });
  }
  throw new Error("header block is neither raw nor zlib-compressed");
}

/**
 * Read the replication timestamp and diff feed from an OSM PBF's header
 * block, the file's first blob. Only that blob is read, so this is cheap on
 * a planet file. Throws when the file does not start with a header block.
 */
export function readOsmPbfHeader(path: string): OsmPbfHeader {
  const headerLength = readPrefix(path, 4, 0).readUInt32BE(0);
  if (headerLength < 1 || headerLength > MAX_BLOB_HEADER_BYTES) {
    throw new Error("not an OSM PBF: implausible blob header length");
  }
  let type: string | undefined;
  let dataSize: number | undefined;
  for (const field of fields(readPrefix(path, headerLength, 4))) {
    if (field.number === 1) type = text(field.value);
    else if (field.number === 3 && typeof field.value === "number") dataSize = field.value;
  }
  if (type !== "OSMHeader") throw new Error("not an OSM PBF: first blob is not OSMHeader");
  if (dataSize === undefined || dataSize < 1 || dataSize > MAX_HEADER_BLOB_BYTES) {
    throw new Error("not an OSM PBF: implausible header blob size");
  }
  const block = headerBlockBytes(readPrefix(path, dataSize, 4 + headerLength));

  const header: OsmPbfHeader = {};
  for (const field of fields(block)) {
    if (field.number === 32 && typeof field.value === "number" && field.value > 0) {
      const at = new Date(field.value * 1000);
      if (!Number.isNaN(at.getTime())) header.timestamp = at.toISOString();
    } else if (field.number === 34) {
      const url = httpsUrl(text(field.value));
      if (url) header.replicationUrl = url;
    }
  }
  return header;
}

/** `readOsmPbfHeader`, or nothing when the file is missing or not readable as one. */
export function tryReadOsmPbfHeader(path: string): OsmPbfHeader {
  try {
    return readOsmPbfHeader(path);
  } catch {
    return {};
  }
}
