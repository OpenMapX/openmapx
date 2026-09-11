import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

async function boundedJson(path: string): Promise<Record<string, unknown>> {
  if ((await stat(path)).size > 16_384)
    throw new Error("Traffic generation metadata exceeds limit");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid traffic generation metadata");
  return value as Record<string, unknown>;
}
/** Independent graph/extract/map epochs plus the actual engine process boot. */
export async function readTrafficGraphState(
  directory: string,
): Promise<{ generation: string; engineBootId: string }> {
  try {
    await stat(join(directory, ".traffic-maintenance.json"));
    throw new Error("Traffic graph maintenance is in progress");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const generation = await boundedJson(join(directory, "traffic-generations.json"));
  const engine = await boundedJson(join(directory, "traffic-engine.json"));
  if (
    generation.schemaVersion !== 1 ||
    typeof generation.graphGeneration !== "string" ||
    !generation.graphGeneration ||
    generation.extractGeneration !== generation.graphGeneration ||
    generation.waysToEdgesGeneration !== generation.graphGeneration ||
    engine.schemaVersion !== 1 ||
    typeof engine.bootId !== "string" ||
    !engine.bootId
  )
    throw new Error("Traffic generations are unavailable or inconsistent");
  const epoch = createHash("sha256")
    .update(JSON.stringify([generation.graphGeneration, engine.bootId]))
    .digest("hex");
  return { generation: epoch, engineBootId: engine.bootId };
}

export async function readTrafficGraphGeneration(directory: string): Promise<string> {
  return (await readTrafficGraphState(directory)).generation;
}
