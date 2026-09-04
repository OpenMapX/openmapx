import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("API Docker privacy fingerprint inputs", () => {
  it("ships the external shared translator and its production dependencies", () => {
    const dockerfile = readFileSync(resolve(import.meta.dirname, "../apps/api/Dockerfile"), "utf8");
    const runner = dockerfile.split("# Production image")[1];
    expect(runner).toContain("COPY packages/i18n/ packages/i18n/");
    expect(runner).toContain(
      "COPY --from=prod-deps /app/packages/i18n/node_modules ./packages/i18n/node_modules",
    );
  });
  it("builds offline without implicitly re-resolving the reviewed lockfile", () => {
    const dockerfile = readFileSync(resolve(import.meta.dirname, "../apps/api/Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      "RUN --network=none pnpm --config.verify-deps-before-run=false build",
    );
  });
  it("copies every reviewed external source family into the strict build context", () => {
    const dockerfile = readFileSync(resolve(import.meta.dirname, "../apps/api/Dockerfile"), "utf8");

    for (const instruction of [
      "COPY --exclude=*/package.json packages/ packages/",
      "COPY apps/api/ apps/api/",
      "COPY apps/ops-agent/src/ apps/ops-agent/src/",
      "COPY apps/web/src/app/(legal)/privacy/ apps/web/src/app/(legal)/privacy/",
      "COPY scripts/check-subject-data.ts scripts/check-subject-data.ts",
      "COPY scripts/validate-privacy-release.mjs scripts/validate-privacy-release.mjs",
      "COPY services/ services/",
    ]) {
      expect(dockerfile).toContain(instruction);
    }
  });
});
