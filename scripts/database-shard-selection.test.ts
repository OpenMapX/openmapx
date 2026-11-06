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
import { describe, expect, it } from "vitest";
import { verifyShardReceipts } from "./database-test-shards.mjs";

const root = resolve(import.meta.dirname, "..");
describe("actual database launcher scenario partitions", () => {
  it("executes every parameter-expanded case exactly once across four fresh runners", () => {
    const temp = mkdtempSync(join(tmpdir(), "openmapx-shard-contract-"));
    try {
      mkdirSync(join(temp, "scripts"));
      mkdirSync(join(temp, "node_modules"));
      symlinkSync(resolve(root, "node_modules/vitest"), join(temp, "node_modules/vitest"), "dir");
      for (const name of [
        "test-database.mjs",
        "database-test-shards.mjs",
        "database-test-shards.json",
        "database-test-timings.json",
      ])
        copyFileSync(resolve(root, "scripts", name), join(temp, "scripts", name));
      writeFileSync(
        join(temp, "scripts/database-test-groups.json"),
        JSON.stringify({ "coordinator-recovery": ["cases.test.mjs"] }),
      );
      writeFileSync(
        join(temp, "vitest.config.mjs"),
        `export default {test:{projects:[{test:{name:'node',include:['*.test.mjs']}}]}};`,
      );
      const cases = [
        "simple",
        "case (one)",
        "regex [two] a|b",
        "literal > delimiter",
        "five",
        "six",
        "seven",
        "eight",
      ];
      writeFileSync(
        join(temp, "cases.test.mjs"),
        `import {describe,it,expect} from 'vitest';import {appendFileSync} from 'node:fs';
    describe('native lifecycle sequence',()=>{ it.each(${JSON.stringify(cases)})('scenario %s',(name)=>{
      expect(name.length).toBeGreaterThan(0);appendFileSync('executions.jsonl',JSON.stringify(name)+'\\n');
    }); });`,
      );
      const receipts = [];
      for (let part = 1; part <= 4; part++) {
        const receipt = join(temp, `receipt-${part}.json`);
        const result = spawnSync(
          process.execPath,
          [join(temp, "scripts/test-database.mjs"), "coordinator-recovery", `${part}/4`],
          {
            cwd: temp,
            env: {
              ...process.env,
              DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:1/openmapx_test",
              GITHUB_SHA: "a".repeat(40),
              OPENMAPX_TEST_SHARD_RECEIPT: receipt,
            },
            encoding: "utf8",
            timeout: 20000,
          },
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        receipts.push(JSON.parse(readFileSync(receipt, "utf8")));
      }
      expect(
        readFileSync(join(temp, "executions.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .sort(),
      ).toEqual([...cases].sort());
      expect(() =>
        verifyShardReceipts(
          receipts,
          [1, 2, 3, 4].map((part) => ({ group: "coordinator-recovery", part, total: 4 })),
          "a".repeat(40),
        ),
      ).not.toThrow();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 90000);
});
