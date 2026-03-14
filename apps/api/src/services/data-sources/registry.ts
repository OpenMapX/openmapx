import type { DataSourceProvider } from "./types.js";

class DataSourceRegistry {
  private providers = new Map<string, DataSourceProvider>();

  register(provider: DataSourceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): DataSourceProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): DataSourceProvider[] {
    return Array.from(this.providers.values());
  }
}

export const dataSourceRegistry = new DataSourceRegistry();
