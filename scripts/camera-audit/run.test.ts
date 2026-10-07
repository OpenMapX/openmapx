import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omx-camera-audit-test-"));
  writeFileSync(
    join(dir, "input.json"),
    JSON.stringify({ osm3s: { timestamp_osm_base: "2020-01-01T00:00:00Z" }, elements: [] }),
  );
  writeFileSync(join(dir, "query.txt"), "bounded fixture query");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      resolve("scripts/camera-audit/run.ts"),
      "--input",
      join(dir, "input.json"),
      "--query",
      join(dir, "query.txt"),
      "--out",
      join(dir, "out"),
      "--source",
      "https://example.org/interpreter",
      "--captured-at",
      new Date().toISOString(),
      "--bbox",
      "6.04,50.75,6.13,50.80",
      ...extra,
    ],
    { encoding: "utf8" },
  );
}
it("writes explicit no-go audit and attributed empty GeoJSON only from a valid complete snapshot", () => {
  const r = run();
  expect(r.status, r.stderr).toBe(0);
  const j = JSON.parse(readFileSync(join(dir, "out/audit.json"), "utf8"));
  expect(j.decisions.awarenessPrototype).toBe("no-go");
  expect(JSON.parse(readFileSync(join(dir, "out/awareness.geojson"), "utf8")).license).toBe(
    "ODbL-1.0",
  );
});
it("does not overwrite previous reports", () => {
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "out/audit.json"), "previous");
  expect(run().status).toBe(1);
  expect(readFileSync(join(dir, "out/audit.json"), "utf8")).toBe("previous");
});
it("failed acquisition never produces an empty success directory", () => {
  writeFileSync(join(dir, "input.json"), '{"remark":"error","elements":[]}');
  expect(run().status).toBe(1);
  expect(existsSync(join(dir, "out"))).toBe(false);
});
it("rejects duplicate/unknown flags and credential sources without echoing sensitive input", () => {
  const r = run(["--source", "https://user:secret@example.org"]);
  expect(r.status).toBe(1);
  expect(r.stderr).not.toContain("secret");
  expect(existsSync(join(dir, "out"))).toBe(false);
  expect(run(["--unknown", "x"]).status).toBe(1);
});
