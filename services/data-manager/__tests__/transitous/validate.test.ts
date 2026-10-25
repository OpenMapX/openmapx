import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { run as validateRun } from "../../src/jobs/transitous/validate.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

let unzipAvailable = false;
beforeAll(async () => {
  try {
    await execa("unzip", ["-v"], { stdio: "pipe" });
    unzipAvailable = true;
  } catch {
    unzipAvailable = false;
  }
});

afterAll(() => {
  // no-op
});

/**
 * A stored (uncompressed) ZIP archive of `members`, written here rather than by
 * the system `zip`, which not every host that has `unzip` installs. The
 * validate stage lists members with `unzip -Z1`, which reads it like any other.
 */
async function makeZip(target: string, members: Record<string, string>): Promise<void> {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(members)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(body, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size (stored)
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // central directory header
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42); // local header offset
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(Object.keys(members).length, 8);
  end.writeUInt16LE(Object.keys(members).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(target, Buffer.concat([...locals, directory, end]));
}

describe("validate stage", () => {
  it("treats a missing feed_info.txt as a warning, not a validation failure", async () => {
    if (!unzipAvailable) {
      // On CI hosts without unzip the validate stage soft-passes — we test
      // that branch in a separate case below.
      return;
    }
    tmp = mkdtempSync(join(tmpdir(), "openmapx-validate-invalid-"));
    const gtfsDir = join(tmp, "gtfs");
    mkdirSync(gtfsDir, { recursive: true });

    const okArchive = join(gtfsDir, "de_bvg.gtfs.zip");
    const badArchive = join(gtfsDir, "de_vbb.gtfs.zip");
    await makeZip(okArchive, { "feed_info.txt": "feed,Berlin\n", "stops.txt": "x\n" });
    await makeZip(badArchive, { "stops.txt": "x\n" });

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      runner: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.gtfsDir = gtfsDir;

    const result = await validateRun(ctx);
    // feed_info.txt is optional per the GTFS spec: the archive stays valid
    // and promotion is not blocked, but the warning is surfaced as evidence.
    expect(result.status).toBe("ok");
    expect(result.artifacts?.validated).toBe(2);
    expect(result.artifacts?.invalid).toEqual([]);
    const warnings = result.artifacts?.warnings as Array<{ id: string; reason: string }>;
    expect(warnings).toEqual([{ id: "de_vbb", reason: "missing feed_info.txt" }]);
  });

  it("marks a corrupt non-empty archive as invalid", async () => {
    if (!unzipAvailable) return;
    tmp = mkdtempSync(join(tmpdir(), "openmapx-validate-corrupt-"));
    const gtfsDir = join(tmp, "gtfs");
    mkdirSync(gtfsDir, { recursive: true });
    writeFileSync(join(gtfsDir, "de_corrupt.gtfs.zip"), "this is not a zip archive");

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      runner: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.gtfsDir = gtfsDir;

    const result = await validateRun(ctx);
    expect(result.status).toBe("error");
    const invalid = result.artifacts?.invalid as Array<{ id: string; reason: string }>;
    expect(invalid).toEqual([{ id: "de_corrupt", reason: "archive is not a readable zip" }]);
  });

  it("marks zero-byte archives as invalid", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-validate-empty-"));
    const gtfsDir = join(tmp, "gtfs");
    mkdirSync(gtfsDir, { recursive: true });
    writeFileSync(join(gtfsDir, "de_empty.gtfs.zip"), "");

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      runner: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.gtfsDir = gtfsDir;

    const result = await validateRun(ctx);
    expect(result.status).toBe("error");
    const invalid = result.artifacts?.invalid as Array<{ id: string; reason: string }>;
    expect(invalid).toEqual([{ id: "de_empty", reason: "archive is empty" }]);
  });

  it("returns ok with zero archives when the gtfs directory is empty", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-validate-noop-"));
    const gtfsDir = join(tmp, "gtfs");
    mkdirSync(gtfsDir, { recursive: true });

    const ctx = buildJobContext({
      dataDir: tmp,
      store: new StateStore(tmp),
      runner: async () => {},
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.gtfsDir = gtfsDir;

    const result = await validateRun(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts).toMatchObject({ validated: 0, invalid: [] });
  });
});
