import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { findServiceManifestDirs } from "./manifest-discovery";
import { validateServiceManifest } from "./manifest-schema";
import type { LoadedService, ServiceManifest } from "./types";

export interface ServiceRegistryOptions {
  rootDir: string;
  servicesDir?: string;
  communityDir?: string;
  /**
   * Community services supplied by the caller instead of scanning
   * `communityDir`. The app-api container has no host checkout, so it reads
   * them from the operations agent, which owns `services/.community`. Each
   * must already have passed the community manifest rules.
   */
  communityServices?: readonly LoadedService[];
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
    if (this.opts.communityServices) {
      for (const service of this.opts.communityServices)
        this.addCommunityService(service, warnings);
    } else if (existsSync(communityDir)) {
      this.scanCommunityDir(communityDir, warnings);
    }
  }

  private addCommunityService(service: LoadedService, warnings: string[]): void {
    if (this.services.some((existing) => existing.manifest.id === service.manifest.id)) {
      warnings.push(
        `Duplicate service id "${service.manifest.id}" at ${service.directory} — keeping first`,
      );
      return;
    }
    this.services.push({
      manifest: service.manifest,
      directory: service.directory,
      isBuiltIn: false,
      enabled: this.opts.enabledIds ? this.opts.enabledIds.has(service.manifest.id) : true,
    });
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
      // Registered clones are named by URL hash; a dot-prefixed entry is an
      // in-flight `.tmp-clone-*` that has not been validated or moved into
      // place yet.
      if (repoEntry.name.startsWith(".")) continue;
      // A community repo may place its service.json next to the service (e.g.
      // services/ingest/service.json), not only at the repo root, so walk the
      // clone with the shared bounded finder rather than a fixed one level.
      for (const svcDir of findServiceManifestDirs(join(dir, repoEntry.name))) {
        this.tryLoadManifest(svcDir, false, warnings);
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

    const validation = validateServiceManifest(raw, { firstParty: isBuiltIn });
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

  applyEnabledIds(enabledIds: Set<string>): void {
    for (const svc of this.services) {
      svc.enabled = enabledIds.has(svc.manifest.id);
    }
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
