import { describe, expect, it } from "vitest";
import { assertBundleImports } from "../integration-bundle-imports";

describe("installed backend bundle imports", () => {
  it.each([
    'import { createPlace } from "@openmapx/integration-sdk/places";',
    'import * as sdk from "@openmapx/integration-sdk";',
    'export { httpError } from "@openmapx/integration-sdk/errors";',
    'import { z } from "zod";',
    'import { z } from "zod/v4";',
    'import { createHash } from "node:crypto";',
    'import { readFile } from "fs/promises";',
    'const http = await import("node:http");',
    "const url = import.meta.url;",
    // Not a literal: cannot be checked without running the code.
    "const name = 'x'; await import(name);",
    // Specifiers inside strings and comments are not imports.
    'const text = "import(\\"fastify\\")"; // import "fastify"',
  ])("accepts %s", async (source) => {
    await expect(assertBundleImports(source)).resolves.toBeUndefined();
  });

  it.each([
    ['import "@openmapx/integration-framework";', "@openmapx/integration-framework"],
    ['import "@openmapx/integration-sdk/not-an-entry";', "@openmapx/integration-sdk/not-an-entry"],
    [
      'import pkg from "@openmapx/integration-sdk/package.json";',
      "@openmapx/integration-sdk/package.json",
    ],
    ['import "@integrations/weather/index.ts";', "@integrations/weather/index.ts"],
    ['export * from "fastify";', "fastify"],
    ['export { a } from "./chunk.mjs";', "./chunk.mjs"],
    ['await import("pg");', "pg"],
    ['await import("file:///etc/passwd");', "file:///etc/passwd"],
    ['import "node:not-a-module";', "node:not-a-module"],
  ])("refuses %s", async (source, specifier) => {
    await expect(assertBundleImports(source)).rejects.toThrow(JSON.stringify(specifier));
  });

  it("refuses a bundle it cannot parse", async () => {
    await expect(assertBundleImports('import { from "zod"')).rejects.toThrow(
      /backend bundle could not be parsed/,
    );
  });
});
