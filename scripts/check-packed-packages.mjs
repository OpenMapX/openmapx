import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "openmapx-packed-packages-"));
const artifacts = join(work, "artifacts");
const consumer = join(work, "consumer");

function run(command, args, cwd = root) {
  execFileSync(command, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_cache: join(work, "npm-cache"),
      npm_config_update_notifier: "false",
    },
    stdio: "inherit",
  });
}

try {
  mkdirSync(artifacts);
  mkdirSync(consumer);

  const cliTarball = join(artifacts, "extension-cli.tgz");
  run("pnpm", ["--filter", "@openmapx/extension-cli", "pack", "--out", cliTarball]);

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "openmapx-package-smoke", private: true, type: "module" }, null, 2)}\n`,
  );
  // Install exactly what a consumer receives. Lifecycle scripts are not needed
  // for these smoke paths, so keep the clean-room install inert.
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", cliTarball],
    consumer,
  );

  const cli = join(consumer, "node_modules/@openmapx/extension-cli/dist/cli.js");
  const scaffoldRoot = join(consumer, "scaffolded");
  run(process.execPath, [cli, "--help"], consumer);
  run(
    process.execPath,
    [cli, "scaffold", "integration", "packed-demo", "--domain", "knowledge", "--out", scaffoldRoot],
    consumer,
  );
  run(process.execPath, [cli, "validate", join(scaffoldRoot, "packed-demo")], consumer);

  console.log("Packed extension CLI consumer smoke checks passed.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
