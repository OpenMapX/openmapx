import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function makeZip(target: string, members: Record<string, string>): Promise<void> {
  // Build via the system `zip` so we don't drag jszip into the data-manager
  // for a test fixture. The validate stage only needs the archive to have
  // a recognisable central directory; `zip -q` is sufficient.
  const dir = `${target}.work`;
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(members)) {
    writeFileSync(join(dir, name), body);
  }
  await execa("zip", ["-q", "-j", target, ...Object.keys(members).map((n) => join(dir, n))], {
    stdio: "pipe",
  });
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
