import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const script = new URL("../scripts/coverage.sh", import.meta.url).pathname;
async function shell(command: string, args: string[] = []) {
  return (
    await exec("bash", ["-c", `source "$1"; shift; ${command}`, "test", script, ...args])
  ).stdout.trim();
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("BRouter coverage", () => {
  it("normalizes Germany and accepts extract paths and planet, rejecting paths and shell input", async () => {
    expect(await shell('normalize_region "$1"', ["germany"])).toBe("europe/germany");
    for (const region of ["planet", "europe", "europe/germany/nordrhein-westfalen"]) {
      expect(await shell('normalize_region "$1"', [region])).toBe(region);
    }
    for (const region of [
      "",
      "../germany",
      "/europe",
      "europe/../asia",
      "europe;id",
      "https://example.com",
    ]) {
      await expect(shell('normalize_region "$1"', [region])).rejects.toThrow();
    }
  });

  it("selects conservative Germany coverage, including the far north and east, from real index rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brouter-coverage-"));
    directories.push(directory);
    const index = join(directory, "index");
    await writeFile(
      index,
      '<a href="E5_N45.rd5">E5_N45.rd5</a> 16-Oct-2026 252564825\r\n<a href="E15_N50.rd5">E15_N50.rd5</a> 16-Oct-2026 90252449\n<a href="E5_N55.rd5">E5_N55.rd5</a> 16-Oct-2026 33707619\n<a href="W5_N50.rd5">W5_N50.rd5</a> 16-Oct-2026 10\n<a href="E20_N50.rd5">E20_N50.rd5</a> 16-Oct-2026 10\n<a href="../evil.rd5">../evil.rd5</a> 16-Oct-2026 1\r\n',
    );
    expect(await shell('select_segments "$1" "5.86 47.27 15.05 55.06"', [index])).toBe(
      "E5_N45.rd5 252564825\nE15_N50.rd5 90252449\nE5_N55.rd5 33707619",
    );
    expect((await shell('select_segments "$1" planet', [index])).split("\n")).toHaveLength(5);
    await writeFile(index, "bad index");
    await expect(shell('select_segments "$1" planet', [index])).rejects.toThrow();
  });

  it("reads polygon bounds and rejects invalid or empty polygons", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brouter-poly-"));
    directories.push(directory);
    const polygon = join(directory, "region.poly");
    await writeFile(polygon, "none\n1\n 5.86 47.27\n 15.05 55.06\nEND\nEND\n");
    expect(await shell('region_bounds "$1"', [polygon])).toBe("5.86 47.27 15.05 55.06");
    for (const contents of ["none\nEND\n", "none\n1\n200 50\nEND\nEND\n"]) {
      await writeFile(polygon, contents);
      await expect(shell('region_bounds "$1"', [polygon])).rejects.toThrow();
    }
  });

  it("stages complete data and rejects truncated replacements without modifying the current generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brouter-download-"));
    directories.push(directory);
    let truncated = false;
    let incompatible = false;
    const data = Buffer.concat([Buffer.from([0, 11]), Buffer.alloc(198)]);
    const server = createServer((request, response) => {
      if (request.url === "/segments/")
        response.end('<a href="E5_N50.rd5">E5_N50.rd5</a> 2026-10-16 200\n');
      else if (request.url === "/segments/E5_N50.rd5")
        response.end(truncated ? data.subarray(0, 20) : incompatible ? Buffer.alloc(200) : data);
      else if (request.url === "/profiles/lookups.dat") response.end("---lookupversion:11\n");
      else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const prepared = await shell(
        'prepare_generation "$1" planet "$2/segments/" "$2/profiles/lookups.dat"',
        [directory, base],
      );
      expect(await readFile(join(prepared, "segments4/E5_N50.rd5"))).toEqual(data);
      await shell('publish_generation "$1" "$2"', [directory, prepared]);
      const active = await readFile(join(directory, "current/segments4/E5_N50.rd5"), "utf8");
      truncated = true;
      await expect(
        shell('prepare_generation "$1" planet "$2/segments/" "$2/profiles/lookups.dat"', [
          directory,
          base,
        ]),
      ).rejects.toThrow();
      expect(await readFile(join(directory, "current/segments4/E5_N50.rd5"), "utf8")).toBe(active);
      truncated = false;
      incompatible = true;
      await expect(
        shell('prepare_generation "$1" planet "$2/segments/" "$2/profiles/lookups.dat"', [
          directory,
          base,
        ]),
      ).rejects.toThrow();
      expect((await readdir(directory)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
