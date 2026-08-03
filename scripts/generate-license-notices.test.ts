import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface LicensePayload {
  notices: Array<{
    name: string;
    version: string;
    license: string;
    licenseText?: string;
  }>;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(repositoryRoot, "apps/web/scripts/generate-license-notices.mjs");
const outputPath = resolve(repositoryRoot, "apps/web/src/generated/open-source-licenses.json");

it("includes data-manager runtime dependency licenses in the generated notices", () => {
  const original = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : undefined;

  try {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", scriptPath],
      { cwd: repositoryRoot, stdio: "pipe" },
    );

    const payload = JSON.parse(readFileSync(outputPath, "utf8")) as LicensePayload;
    const glyphComposite = payload.notices.find(
      (notice) => notice.name === "@mapbox/glyph-pbf-composite",
    );
    const protocolBuffers = payload.notices.find((notice) => notice.name === "protocol-buffers");

    expect(glyphComposite).toEqual(
      expect.objectContaining({
        name: "@mapbox/glyph-pbf-composite",
        version: "0.0.3",
      }),
    );
    expect(glyphComposite?.licenseText).toContain("BSD 2-Clause License");
    expect(protocolBuffers).toBeDefined();
  } finally {
    if (original === undefined) {
      if (existsSync(outputPath)) unlinkSync(outputPath);
    } else writeFileSync(outputPath, original, "utf8");
  }
});
