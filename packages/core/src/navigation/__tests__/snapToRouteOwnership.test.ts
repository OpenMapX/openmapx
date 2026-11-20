import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codeOnly, productionSources } from "../../__tests__/support/sourceScan";

/**
 * `snapToRoute` scans a whole route per call. It lives only in test support as
 * the numerical reference for the prepared matcher, so no production module may
 * reference it. Doc-comment references to it, the matcher's own contract notes,
 * are prose and do not count.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../..");
const ROOTS = ["packages/core/src", "apps/web/src", "integrations"];

describe("snapToRoute production callers", () => {
  const referencing = ROOTS.flatMap((root) => productionSources(join(REPO_ROOT, root)))
    .filter((path) => {
      const text = readFileSync(path, "utf8");
      return text.includes("snapToRoute") && /\bsnapToRoute\b/.test(codeOnly(text, path));
    })
    .map((path) => relative(REPO_ROOT, path).split(sep).join("/"))
    .sort();

  it("is not referenced by any production module", () => {
    expect(referencing).toEqual([]);
  });
});
