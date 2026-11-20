import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A fresh, mutable copy of a trimmed live upstream document. */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(directory, name), "utf8")) as T;
}

export function fixtureRecord(
  file: "barrelman-assets.json" | "open-landmarks-assets.json",
  id: string,
): Record<string, unknown> {
  const document = fixture<{ assets: Record<string, unknown>[] }>(file);
  const record = document.assets.find((asset) => asset.id === id);
  if (!record) throw new Error(`fixture record ${id} missing from ${file}`);
  return record;
}
