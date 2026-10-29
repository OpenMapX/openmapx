import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
// Explicit opt-in: the portable suite does not require a downloaded JVM/engine.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone Vitest opt-in, not a Turbo task
const distribution = process.env.OPENMAPX_BROUTER_TEST_DISTRIBUTION;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe.skipIf(!distribution)("BRouter native candidate validation", () => {
  async function validate(truncated: boolean) {
    if (!distribution) throw new Error("Native BRouter distribution is not configured");
    const directory = await mkdtemp(join(tmpdir(), "brouter-native-"));
    directories.push(directory);
    await cp(join(distribution, "profiles2"), join(directory, "profiles2"), { recursive: true });
    if (truncated)
      await writeFile(join(directory, "profiles2/lookups.dat"), "---lookupversion:11\n");
    return exec(
      "java",
      [
        "-cp",
        join(distribution, "brouter-1.7.10-all.jar"),
        new URL("../scripts/ValidateProfiles.java", import.meta.url).pathname,
        join(directory, "profiles2"),
      ],
      { timeout: 15000 },
    );
  }
  it("accepts the actual bundled profiles through the pinned BRouter parser", async () => {
    await expect(validate(false)).resolves.toBeDefined();
  });
  it("rejects a header-only lookup table before publication", async () => {
    await expect(validate(true)).rejects.toThrow();
  });
});
