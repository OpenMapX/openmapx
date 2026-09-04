import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePrivacySourceFingerprint } from "../apps/api/privacy-source-fingerprint.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

export async function validatePrivacyRelease(options = {}) {
  const fingerprint =
    options.fingerprint ?? (() => computePrivacySourceFingerprint(options.repoRoot ?? repoRoot));
  const before = await fingerprint();
  for (const command of ["check-translations", "check-openapi", "check:policy"]) {
    const result = options.runCheck
      ? await options.runCheck(command)
      : spawnSync("pnpm", [command], {
          cwd: options.repoRoot ?? repoRoot,
          stdio: "inherit",
        }).status === 0;
    if (!result) throw new Error(`Privacy release validation failed: ${command}`);
  }
  const after = await fingerprint();
  if (after !== before)
    throw new Error("Privacy release source changed while validation was running");
  return {
    version: 1,
    sourceBuildFingerprint: after,
    validatedAt: new Date().toISOString(),
    checks: {
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output || !isAbsolute(output))
    throw new Error("Pass an absolute privacy release validation evidence path");
  const evidence = await validatePrivacyRelease();
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${randomBytes(12).toString("hex")}.partial`;
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o400,
      flag: "wx",
    });
    await rename(temporary, output);
    await chmod(output, 0o400);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  console.log(`Privacy release validation evidence written for ${evidence.sourceBuildFingerprint}`);
}
