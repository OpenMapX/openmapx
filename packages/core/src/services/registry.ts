import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateServiceManifest } from "./manifest-schema";
import type { LoadedService, ServiceManifest } from "./types";

export interface ServiceRegistryOptions {
  rootDir: string;
  servicesDir?: string;
  communityDir?: string;
  enabledIds?: Set<string>;
  warnings?: string[];
}

export class ServiceRegistry {
  private services: LoadedService[] = [];
  private opts: ServiceRegistryOptions;

  constructor(opts: ServiceRegistryOptions) {
    this.opts = opts;
  }

  async load(): Promise<void> {
    this.services = [];
    const servicesDir = this.opts.servicesDir ?? join(this.opts.rootDir, "services");
    const communityDir = this.opts.communityDir ?? join(servicesDir, ".community");
    const warnings = this.opts.warnings ?? [];

    if (existsSync(servicesDir)) {
      this.scanBuiltInDir(servicesDir, warnings);
    }
    if (existsSync(communityDir)) {
      this.scanCommunityDir(communityDir, warnings);
    }
  }

  private scanBuiltInDir(dir: string, warnings: string[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      this.tryLoadManifest(join(dir, entry.name), true, warnings);
    }
  }

  private scanCommunityDir(dir: string, warnings: string[]): void {
    for (const repoEntry of readdirSync(dir, { withFileTypes: true })) {
      if (!repoEntry.isDirectory()) continue;
      const repoDir = join(dir, repoEntry.name);
      for (const svcEntry of readdirSync(repoDir, { withFileTypes: true })) {
        if (!svcEntry.isDirectory()) continue;
        this.tryLoadManifest(join(repoDir, svcEntry.name), false, warnings);
      }
    }
  }

  private tryLoadManifest(directory: string, isBuiltIn: boolean, warnings: string[]): void {
    const manifestPath = join(directory, "service.json");
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) return;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      warnings.push(`Failed to parse ${manifestPath}: ${(err as Error).message}`);
      return;
    }

    const validation = validateServiceManifest(raw);
    if (!validation.valid) {
      warnings.push(`Invalid manifest ${manifestPath}: ${validation.errors.join("; ")}`);
      return;
    }

    const manifest = raw as ServiceManifest;
    if (this.services.some((s) => s.manifest.id === manifest.id)) {
      warnings.push(`Duplicate service id "${manifest.id}" at ${directory} — keeping first`);
      return;
    }

    const enabled = this.opts.enabledIds ? this.opts.enabledIds.has(manifest.id) : true;
    this.services.push({
      manifest,
      directory: resolve(directory),
      isBuiltIn,
      enabled,
    });
  }

  list(): LoadedService[] {
    return [...this.services];
  }

  enabled(): LoadedService[] {
    return this.services.filter((s) => s.enabled);
  }

  get(id: string): LoadedService | undefined {
    return this.services.find((s) => s.manifest.id === id);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const svc = this.services.find((s) => s.manifest.id === id);
    if (!svc) return false;
    svc.enabled = enabled;
    return true;
  }
}
