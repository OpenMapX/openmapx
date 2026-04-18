import { existsSync, linkSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface HardlinkEntry {
  source: string;
  target: string;
  consumerService: string;
  dataType: string;
}

export interface ApplyHardlinkOptions {
  rootDir: string;
}

export interface ApplyHardlinkResult {
  linked: number;
  skipped: number;
}

export async function applyHardlinkPlan(
  plan: HardlinkEntry[],
  opts: ApplyHardlinkOptions,
): Promise<ApplyHardlinkResult> {
  let linked = 0;
  let skipped = 0;

  for (const entry of plan) {
    const source = isAbsolute(entry.source) ? entry.source : resolve(opts.rootDir, entry.source);
    const target = isAbsolute(entry.target) ? entry.target : resolve(opts.rootDir, entry.target);

    if (!existsSync(source) || !statSync(source).isDirectory()) continue;

    mkdirSync(target, { recursive: true });

    for (const file of readdirSync(source)) {
      const srcFile = join(source, file);
      if (!statSync(srcFile).isFile()) continue;
      const tgtFile = join(target, file);

      if (existsSync(tgtFile)) {
        const srcStat = statSync(srcFile);
        const tgtStat = statSync(tgtFile);
        if (srcStat.ino === tgtStat.ino && srcStat.dev === tgtStat.dev) {
          skipped++;
          continue;
        }
      }

      try {
        linkSync(srcFile, tgtFile);
        linked++;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          skipped++;
        } else {
          throw err;
        }
      }
    }
  }

  return { linked, skipped };
}
