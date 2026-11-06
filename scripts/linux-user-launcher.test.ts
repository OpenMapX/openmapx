import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("runs through the installed Vitest wrapper without a global pnpm executable", () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "openmapx-linux-launcher-"));
  try {
    mkdirSync(join(temp, "scripts"));
    mkdirSync(join(temp, "packages/core"), { recursive: true });
    mkdirSync(join(temp, "bin"));
    symlinkSync(process.execPath, join(temp, "bin/node"));
    symlinkSync(join(root, "node_modules"), join(temp, "node_modules"), "dir");
    for (const name of [
      "test-linux-user.mjs",
      "database-test-shards.mjs",
      "database-test-shards.json",
      "database-test-timings.json",
    ])
      copyFileSync(join(root, "scripts", name), join(temp, "scripts", name));
    writeFileSync(
      join(temp, "vitest.config.mjs"),
      "export default {test:{projects:[{test:{name:'node',include:['packages/core/*.test.mjs']}}]}};",
    );
    for (const name of ["one", "two"])
      writeFileSync(
        join(temp, `packages/core/${name}.test.mjs`),
        "import {it,expect} from 'vitest';it('preserves wrapper resolution',()=>expect(process.env.NODE_PATH).toContain('.pnpm/node_modules'));",
      );
    for (const part of [1, 2]) {
      const receipt = join(temp, `receipt-${part}.json`);
      const result = spawnSync(
        process.execPath,
        [join(temp, "scripts/test-linux-user.mjs"), `${part}/2`],
        {
          cwd: temp,
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            PATH: `${join(temp, "bin")}:/usr/bin:/bin`,
            NODE_PATH: "",
            OPENMAPX_TEST_SHARD_RECEIPT: receipt,
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(receipt, "utf8")).selected).toHaveLength(1);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 90000);
