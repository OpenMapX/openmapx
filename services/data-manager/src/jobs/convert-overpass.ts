import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execa } from "execa";

export interface ConvertOverpassOptions {
  sourcePbf: string;
  targetBz2: string;
}

export async function convertPbfToBz2(opts: ConvertOverpassOptions): Promise<void> {
  mkdirSync(dirname(opts.targetBz2), { recursive: true });
  // osmium cat reads PBF and writes a bz2-compressed OSM XML — Overpass's expected format.
  await execa("osmium", ["cat", opts.sourcePbf, "-o", opts.targetBz2, "-O"], { stdio: "inherit" });
}
