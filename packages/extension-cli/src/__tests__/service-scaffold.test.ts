import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scaffoldService } from "../commands/scaffold.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-service-scaffold-"));
});
afterEach(() => {
  vi.mocked(writeFileSync).mockReset();
  rmSync(root, { recursive: true, force: true });
});

describe("service scaffold destination safety", () => {
  it("preserves a file created between the existence check and final write", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const destination = join(root, "service.json");
    vi.mocked(writeFileSync).mockImplementationOnce((...args) => {
      fs.writeFileSync(destination, "concurrent author's bytes");
      fs.writeFileSync(...args);
    });

    expect(() => scaffoldService({ id: "demo", outDir: root })).toThrow(
      `"${destination}" already exists. Remove it first or choose a different output directory.`,
    );
    expect(readFileSync(destination, "utf8")).toBe("concurrent author's bytes");
  });

  it("preserves an ordinary existing destination with the friendly collision error", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const destination = join(root, "service.json");
    fs.writeFileSync(destination, "existing bytes");
    expect(() => scaffoldService({ id: "demo", outDir: root })).toThrow(/already exists/);
    expect(readFileSync(destination, "utf8")).toBe("existing bytes");
  });

  it("propagates a non-collision write error unchanged", () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw error;
    });
    expect(() => scaffoldService({ id: "demo", outDir: root })).toThrow(error);
  });
});
