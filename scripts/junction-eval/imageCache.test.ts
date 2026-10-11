import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheEvaluationImage } from "./imageCache";

const folders: string[] = [];
const folder = () => {
  const value = mkdtempSync(join(tmpdir(), "junction-cache-"));
  folders.push(value);
  return value;
};
const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 2, 255, 217]);
const asset = "https://images.example/photo.jpg";
afterEach(() => {
  for (const value of folders.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("evaluation image cache", () => {
  it("does not overwrite a file created while the image is downloading", async () => {
    const directory = folder();
    const original = Uint8Array.from([...jpeg, 1]);
    const result = await cacheEvaluationImage(directory, "image-01", asset, async () => {
      writeFileSync(join(directory, "image-01.jpg"), original);
      return new Response(jpeg);
    });
    expect(result).toBe("image-01.jpg");
    expect(readFileSync(join(directory, result))).toEqual(Buffer.from(original));
  });

  it("does not follow a symlink planted during the download", async () => {
    const directory = folder();
    const outside = join(folder(), "keep.txt");
    writeFileSync(outside, "keep");
    await expect(
      cacheEvaluationImage(directory, "image-01", asset, async () => {
        symlinkSync(outside, join(directory, "image-01.jpg"));
        return new Response(jpeg);
      }),
    ).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  it("stores photo bytes and reuses a regular cache file without another request", async () => {
    const directory = folder();
    await cacheEvaluationImage(directory, "image-01", asset, async () => new Response(jpeg));
    const cached = await cacheEvaluationImage(directory, "image-01", asset, async () => {
      throw new Error("cache should be reused");
    });
    expect(readFileSync(join(directory, cached))).toEqual(Buffer.from(jpeg));
  });

  it("rejects path traversal before requesting or writing an asset", async () => {
    const directory = folder();
    await expect(
      cacheEvaluationImage(directory, "../outside", asset, async () => {
        throw new Error("must not request invalid id");
      }),
    ).rejects.toThrow("invalid-image-id");
  });

  it.each([
    ["HTML", new Response("<script>bad</script>")],
    ["oversized", new Response(jpeg, { headers: { "content-length": "8000001" } })],
    ["failure", new Response("missing", { status: 404 })],
  ])("does not cache %s responses", async (_name, response) => {
    await expect(
      cacheEvaluationImage(folder(), "image-01", asset, async () => response),
    ).rejects.toThrow();
  });
});
