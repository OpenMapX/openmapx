import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_SCRIPT_FONTS,
  buildScriptFontFaces,
  collectStyleFontFaceUrls,
  rewriteStyleFontFaces,
} from "./scriptFontFaces";

const PUBLIC_DIR = join(import.meta.dirname, "../../public");
const LICENSE_SCRIPT_PATH = join(import.meta.dirname, "../../scripts/generate-license-notices.mjs");
const SCRIPT_FONTS_README_PATH = join(PUBLIC_DIR, "fonts/scripts/README.md");

const WOFF2_KNOWN_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
] as const;

function readUIntBase128(buf: Buffer, offset: number): [number, number] {
  let accum = 0;
  let cursor = offset;
  for (let i = 0; i < 5; i++) {
    const byte = buf[cursor++] ?? 0;
    accum = (accum << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return [accum, cursor];
  }
  throw new Error("invalid WOFF2 UIntBase128");
}

/** Extract OpenType `name` table records by nameID directly from a WOFF2 file. */
function readWoff2NameRecords(filePath: string): Map<number, string> {
  const buf = readFileSync(filePath);
  const numTables = buf.readUInt16BE(12);
  const totalCompressedSize = buf.readUInt32BE(20);
  let cursor = 48;
  let streamOffset = 0;
  let nameOffset = -1;
  let nameLength = 0;

  for (let i = 0; i < numTables; i++) {
    const flags = buf[cursor++] ?? 0;
    const tagIndex = flags & 0x3f;
    const transformVersion = (flags >>> 6) & 0x03;
    let tag: string;
    if (tagIndex === 63) {
      tag = buf.subarray(cursor, cursor + 4).toString("ascii");
      cursor += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[tagIndex] ?? "";
    }
    const [origLength, afterOrig] = readUIntBase128(buf, cursor);
    cursor = afterOrig;
    const isTransformed =
      tag === "glyf" || tag === "loca" ? transformVersion !== 3 : transformVersion !== 0;
    let lengthInStream = origLength;
    if (isTransformed) {
      const [transformLength, afterTransform] = readUIntBase128(buf, cursor);
      cursor = afterTransform;
      lengthInStream = transformLength;
    }
    if (tag === "name") {
      nameOffset = streamOffset;
      nameLength = lengthInStream;
    }
    streamOffset += lengthInStream;
  }

  if (nameOffset < 0) throw new Error(`missing name table in ${filePath}`);
  const decompressed = brotliDecompressSync(buf.subarray(cursor, cursor + totalCompressedSize));
  const table = decompressed.subarray(nameOffset, nameOffset + nameLength);
  const count = table.readUInt16BE(2);
  const stringOffset = table.readUInt16BE(4);
  const records = new Map<number, string>();

  for (let i = 0; i < count; i++) {
    const base = 6 + i * 12;
    const platformId = table.readUInt16BE(base);
    const nameId = table.readUInt16BE(base + 6);
    const length = table.readUInt16BE(base + 8);
    const offset = table.readUInt16BE(base + 10);
    const raw = table.subarray(stringOffset + offset, stringOffset + offset + length);
    if (platformId === 3 || platformId === 0) {
      let decoded = "";
      for (let j = 0; j + 1 < raw.length; j += 2) {
        decoded += String.fromCharCode(raw.readUInt16BE(j));
      }
      records.set(nameId, decoded);
    } else if (platformId === 1 && !records.has(nameId)) {
      records.set(nameId, raw.toString("latin1"));
    }
  }
  return records;
}

describe("scriptFontFaces", () => {
  it("ships every declared WOFF2 file on disk with valid headers, versions, and OFL copyright notices", () => {
    const licenseScript = readFileSync(LICENSE_SCRIPT_PATH, "utf8");
    const readme = readFileSync(SCRIPT_FONTS_README_PATH, "utf8");

    for (const font of BUNDLED_SCRIPT_FONTS) {
      const filePath = join(PUBLIC_DIR, font.path);
      expect(existsSync(filePath), `missing ${font.path}`).toBe(true);
      const header = readFileSync(filePath).subarray(0, 4).toString("ascii");
      expect(header).toBe("wOF2");

      const names = readWoff2NameRecords(filePath);
      const embeddedCopyright = names.get(0);
      const embeddedVersion = names.get(5);
      expect(embeddedCopyright, `${font.path} copyright`).toBeTruthy();
      expect(embeddedVersion, `${font.path} version`).toContain(`Version ${font.version}`);
      expect(licenseScript, `${font.path} copyright in license notices`).toContain(
        embeddedCopyright,
      );
      expect(licenseScript, `${font.path} version in license notices`).toContain(font.version);
      expect(readme, `${font.path} version in README`).toContain(font.version);
    }
  });

  it("maps all three basemap Noto Sans weights with versioned URLs and narrow script ranges", () => {
    const faces = buildScriptFontFaces("https://maps.example/");
    expect(Object.keys(faces)).toEqual(["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"]);

    for (const entries of Object.values(faces)) {
      expect(Array.isArray(entries)).toBe(true);
      const list = entries as Array<{ url: string; "unicode-range"?: string[] }>;
      expect(list).toHaveLength(BUNDLED_SCRIPT_FONTS.length);
      for (const face of list) {
        expect(face.url).toMatch(
          /^https:\/\/maps\.example\/fonts\/scripts\/.+\.woff2\?v=\d+\.\d+$/,
        );
        expect(face["unicode-range"]?.length).toBeGreaterThan(0);
        // Must never claim Basic Latin or general combining marks.
        expect(face["unicode-range"]).not.toContain("U+0000-00FF");
        expect(face["unicode-range"]).not.toContain("U+0300-036F");
      }
    }
  });

  it("collects unique URLs and rewrites every declared font face immutably", () => {
    const original = buildScriptFontFaces("https://maps.example");
    const urls = collectStyleFontFaceUrls(original);
    expect(urls).toHaveLength(BUNDLED_SCRIPT_FONTS.length);

    const rewritten = rewriteStyleFontFaces(original, (url) => `${url}&offlineGlyphs=v1`);
    expect(collectStyleFontFaceUrls(rewritten)).toEqual(urls.map((u) => `${u}&offlineGlyphs=v1`));
    // Original object stays untouched.
    expect(collectStyleFontFaceUrls(original)).toEqual(urls);
  });
});
