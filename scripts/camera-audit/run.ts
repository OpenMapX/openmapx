import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditCameraSnapshot, type Review } from "./audit.ts";

try {
  const allowed = new Set([
    "--input",
    "--query",
    "--source",
    "--captured-at",
    "--bbox",
    "--out",
    "--review",
  ]);
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i],
      value = process.argv[i + 1];
    if (!allowed.has(key) || args.has(key) || !value || value.startsWith("--"))
      throw new Error("Invalid or duplicate arguments");
    args.set(key, value);
  }
  const required = (key: string) => {
    const value = args.get(key);
    if (!value) throw new Error("Missing required arguments");
    return value;
  };
  for (const key of allowed) if (key !== "--review") required(key);
  const read = (path: string) => {
    if (statSync(path).size > 5 * 1024 * 1024) throw new Error("Input size exceeds 5 MiB");
    return readFileSync(path);
  };
  const bbox = required("--bbox").split(",").map(Number);
  if (bbox.length !== 4) throw new Error("Invalid regional bbox");
  const review = args.get("--review");
  const { audit, geojson } = auditCameraSnapshot(
    read(required("--input")),
    read(required("--query")),
    {
      source: required("--source"),
      capturedAt: required("--captured-at"),
      bbox: bbox as [number, number, number, number],
      review: review ? (JSON.parse(read(review).toString("utf8")) as Review[]) : undefined,
    },
  );
  const out = resolve(required("--out"));
  // A new directory is the completion boundary: never overwrite prior evidence.
  mkdirSync(out);
  try {
    writeFileSync(resolve(out, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`, {
      flag: "wx",
    });
    writeFileSync(resolve(out, "awareness.geojson"), `${JSON.stringify(geojson, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
  console.log(
    `Camera audit written: awareness prototype ${audit.decisions.awarenessPrototype}; production and routing no-go.`,
  );
} catch {
  // Avoid raw payloads, URLs, contributor data and local path disclosure.
  console.error(
    "Camera audit failed. Check required flags, bounded complete input, matching review versions and a new writable output directory. No successful audit is established.",
  );
  process.exitCode = 1;
}
