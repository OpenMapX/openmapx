import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectRequiredFeedCredentialKeys } from "../src/feed-credential-requirements";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function catalog() {
  const root = mkdtempSync(join(tmpdir(), "omx-credential-catalog-"));
  roots.push(root);
  mkdirSync(join(root, "feeds"));
  mkdirSync(join(root, "transitland-atlas/feeds"), { recursive: true });
  writeFileSync(
    join(root, "transitland-atlas/feeds/a.dmfr.json"),
    JSON.stringify({ feeds: [{ id: "auth", authorization: { type: "api-key" } }, { id: "open" }] }),
  );
  return root;
}
it("discovers requirements only from the supplied isolated catalog and atlas", () => {
  const a = catalog(),
    b = catalog();
  writeFileSync(
    join(a, "feeds/de.json"),
    JSON.stringify({
      sources: [
        { name: "A", "transitland-atlas-id": "auth" },
        { name: "Open", "transitland-atlas-id": "open" },
        { name: "Inline", "transitland-atlas-id": "auth", "api-key": "already" },
        {
          name: "Override",
          "transitland-atlas-id": "auth",
          "url-override": "https://example.test",
        },
      ],
    }),
  );
  writeFileSync(
    join(b, "feeds/de.json"),
    JSON.stringify({ sources: [{ name: "B", "transitland-atlas-id": "auth" }] }),
  );
  expect(collectRequiredFeedCredentialKeys(a)).toEqual(["de/A"]);
  expect(collectRequiredFeedCredentialKeys(b)).toEqual(["de/B"]);
});
it("refuses missing, malformed or linked catalog inputs rather than erasing requirements", () => {
  const root = catalog();
  expect(() => collectRequiredFeedCredentialKeys(join(root, "missing"))).toThrow();
  writeFileSync(join(root, "feeds/de.json"), "invalid");
  expect(() => collectRequiredFeedCredentialKeys(root)).toThrow(/Catalog/);
  rmSync(join(root, "feeds/de.json"));
  symlinkSync(join(root, "transitland-atlas/feeds/a.dmfr.json"), join(root, "feeds/de.json"));
  expect(() => collectRequiredFeedCredentialKeys(root)).toThrow(/Catalog/);
});
