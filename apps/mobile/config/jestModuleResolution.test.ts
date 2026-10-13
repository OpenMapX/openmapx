import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const config = require("../jest.config.cjs") as {
  rootDir: string;
  moduleNameMapper: Record<string, string | string[]>;
};

describe("native test contributor module resolution", () => {
  it.each(["contributors", "raster-contributors", "transit-contributors", "transit"])(
    "resolves the public %s source through the actual Jest mapping",
    (module) => {
      const specifier = `@openmapx/mobility-core/${module}`;
      const entry = Object.entries(config.moduleNameMapper).find(([pattern]) =>
        new RegExp(pattern).test(specifier),
      );
      expect(entry).toBeDefined();
      if (!entry) throw new Error(`Missing mapping for ${specifier}`);
      const replacements = Array.isArray(entry[1]) ? entry[1] : [entry[1]];
      const candidates = replacements.map((replacement) =>
        resolve(
          specifier.replace(new RegExp(entry[0]), replacement).replace("<rootDir>", config.rootDir),
        ),
      );
      expect(candidates.some(existsSync)).toBe(true);
      expect(candidates).toContain(
        resolve(
          fileURLToPath(new URL("../../../packages/mobility-core/src/", import.meta.url)),
          `${module === "transit" ? "types/" : ""}${module}.ts`,
        ),
      );
    },
  );
});
