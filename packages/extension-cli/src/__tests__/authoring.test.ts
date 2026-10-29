import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBundle } from "../commands/bundle.js";
import { scaffoldService } from "../commands/scaffold.js";
import { validateAuthoringInput } from "../commands/validate.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "extension-author-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const doc = {
  id: "demo",
  name: "Demo",
  version: "0.1.0",
  platform: "1.0",
  services: [{ repo: "https://github.com/example/demo", ref: "v0.1.0", service: "demo-service" }],
  config: [{ key: "DEMO_MODE", target: "service:demo-service", default: "fixture" }],
  readiness: { requires: ["service:demo-service"] },
};

describe("complete authoring input", () => {
  it("validates and emits config/readiness from a complete input document", () => {
    const input = join(dir, "source.json");
    const out = join(dir, "extension.json");
    writeFileSync(input, JSON.stringify(doc));
    runBundle({ input, out });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(doc);
  });
  it("rejects undeclared readiness before creating an output file", () => {
    const input = join(dir, "source.json");
    const out = join(dir, "extension.json");
    writeFileSync(input, JSON.stringify({ ...doc, readiness: { requires: ["service:missing"] } }));
    expect(() => runBundle({ input, out })).toThrow(/declared component/);
    expect(existsSync(out)).toBe(false);
  });
  it("rejects mixed complete-input and component flags", () => {
    const input = join(dir, "source.json");
    writeFileSync(input, JSON.stringify(doc));
    expect(() => runBundle({ input, out: join(dir, "out.json"), id: "override" })).toThrow(
      /combine/,
    );
  });
  it("validates the service scaffold as community, and rejects host privileges", async () => {
    const source = scaffoldService({ id: "demo-service", outDir: dir });
    expect((await validateAuthoringInput(source, "service")).valid).toBe(true);
    const manifest = JSON.parse(readFileSync(source, "utf8"));
    manifest.container.privileged = true;
    writeFileSync(source, JSON.stringify(manifest));
    const result = await validateAuthoringInput(source, "service");
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/privileged/);
  });
  it("rejects malformed JSON and malformed contributor receipts", async () => {
    const source = join(dir, "input.json");
    writeFileSync(source, "{");
    expect((await validateAuthoringInput(source, "extension")).valid).toBe(false);
    writeFileSync(source, JSON.stringify([{ sourceId: "demo", name: 3 }]));
    expect((await validateAuthoringInput(source, "contributors")).valid).toBe(false);
    writeFileSync(source, "[]");
    expect((await validateAuthoringInput(source, "contributors")).valid).toBe(true);
  });
});

describe("bundle protocol preflight", () => {
  for (const platform of ["0.9", "1.1", "2.0", "", "bogus"]) {
    for (const mode of ["flags", "input"] as const) {
      it(`rejects ${mode} protocol ${JSON.stringify(platform)} without overwriting a bundle`, () => {
        const out = join(dir, "extension.json");
        const original = JSON.stringify(doc);
        writeFileSync(out, original);
        const input = join(dir, "source.json");
        writeFileSync(input, JSON.stringify({ ...doc, platform }));
        const opts =
          mode === "input"
            ? { input, out }
            : {
                id: doc.id,
                name: doc.name,
                version: doc.version,
                platform,
                service: ["https://github.com/example/demo,v0.1.0,demo-service"],
                out,
              };
        expect(() => runBundle(opts)).toThrow(/protocol|major.minor/);
        expect(readFileSync(out, "utf8")).toBe(original);
        rmSync(out);
        expect(() => runBundle(opts)).toThrow(/protocol|major.minor/);
        expect(existsSync(out)).toBe(false);
      });
    }
  }
});
