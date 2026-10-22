import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
describe("OTP generated contract", () => {
  it("retains the unmodified pinned schema", () => {
    expect(
      createHash("sha256")
        .update(readFileSync(resolve(root, "packages/otp-client/schema/gtfs-2.10.graphql")))
        .digest("hex"),
    ).toBe("ee5c42d5fd6346b6062d057030f8cb2062517b31e93add66ca5a92cae247aac4");
  });
  it("validates every operation and reproduces committed SDK and selected result validators offline", () => {
    expect(() =>
      execFileSync(process.execPath, ["packages/otp-codegen/generate.mjs", "--check"], {
        cwd: root,
        timeout: 90000,
        stdio: "pipe",
      }),
    ).not.toThrow();
  }, 90000);
});

function generate(document: string) {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {generateArtifacts} from './packages/otp-codegen/generate.mjs'; await generateArtifacts({document: ${JSON.stringify(document)}});`,
    ],
    { cwd: root, timeout: 90000, stdio: "pipe" },
  );
}
describe("OTP generation refuses contract drift", () => {
  it.each([
    "query Invalid { nonexistent }",
    "query Invalid($first: String) { planConnection(origin: {location: {coordinate: {latitude: 48, longitude: 11}}}, destination: {location: {coordinate: {latitude: 49, longitude: 12}}}, first: $first) { edges { node { start } } } }",
    "query Invalid { planConnection(origin: {location: {coordinate: {latitude: 48, longitude: 11}}}, destination: {location: {coordinate: {latitude: 49, longitude: 12}}}, dateTime: {earliestDeparture: null, latestArrival: null}) { edges { node { start } } } }",
  ])("rejects invalid fields, variable types and oneOf input: %s", (document) => {
    expect(() => generate(document)).toThrow();
  });
  it("keeps the application GraphQL version separate from the build tool", () => {
    const app = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const tool = JSON.parse(
      readFileSync(resolve(root, "packages/otp-codegen/package.json"), "utf8"),
    );
    expect(app.devDependencies.graphql).toBe("17.0.2");
    expect(tool.devDependencies.graphql).toBe("16.14.2");
    const client = JSON.parse(
      readFileSync(resolve(root, "packages/otp-client/package.json"), "utf8"),
    );
    expect(client.dependencies).not.toHaveProperty("graphql");
  });
});

describe("generated validator projection", () => {
  it("retains whole declarations and dependency order without unrelated input validators", () => {
    const source = `export const ModeSchema = z.enum(['BUS']);\nexport const UnusedInputSchema = z.object({x:z.string()});\nexport const TestQuerySchema: z.ZodType<TestQuery> = z.object({mode:ModeSchema});`;
    const script = `import {selectOperationValidators} from './packages/otp-codegen/generate.mjs'; console.log(selectOperationValidators(${JSON.stringify(source)}, ['TestQuery']));`;
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result).toContain("export const ModeSchema = z.enum(['BUS']);");
    expect(result).toContain(
      "export const TestQuerySchema: z.ZodType<TestQuery> = z.object({mode:ModeSchema});",
    );
    expect(result).not.toContain("UnusedInputSchema");
    expect(result.indexOf("const ModeSchema")).toBeLessThan(
      result.indexOf("const TestQuerySchema"),
    );
  });
  it("fails if a generated result's schema dependency cannot be retained", () => {
    const script = `import {selectOperationValidators} from './packages/otp-codegen/generate.mjs'; selectOperationValidators('export const TestQuerySchema = MissingSchema;', ['TestQuery']);`;
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: root,
        timeout: 10000,
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
