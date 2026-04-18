import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (existsSync(join(dir, "turbo.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not find repo root (no pnpm-workspace.yaml above ${start})`);
}

export interface RepoPaths {
  root: string;
  servicesDir: string;
  communityDir: string;
  infraDir: string;
  composeOutPath: string;
  envOutPath: string;
}

export function repoPaths(start?: string): RepoPaths {
  const root = findRepoRoot(start);
  return {
    root,
    servicesDir: join(root, "services"),
    communityDir: join(root, "services", ".community"),
    infraDir: join(root, "infra", "docker"),
    composeOutPath: join(root, "infra", "docker", "docker-compose.generated.yml"),
    envOutPath: join(root, "infra", "docker", ".env.generated"),
  };
}
