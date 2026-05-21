import type { ComponentType } from "react";

/**
 * A community integration frontend module registers itself by pushing
 * a CommunityIntegrationModule onto the global registry.
 *
 * Pre-built bundles call:
 *   window.__openmapx_integrations.push({ id, mapLayer, legend, ... })
 */
export interface CommunityIntegrationModule {
  /** Must match the integration's manifest.id */
  id: string;
  /** Map layer component (equivalent of map-layer.tsx) */
  mapLayer?: ComponentType;
  /** Legend/toolbar component (equivalent of legend.tsx) */
  legend?: ComponentType;
  /** Panel component (equivalent of panel.tsx) */
  panel?: ComponentType;
}

declare global {
  interface Window {
    __openmapx_integrations: CommunityIntegrationModule[];
  }
}

const communityModules = new Map<string, CommunityIntegrationModule>();

/** Register a community integration module (called from bundle self-registration). */
export function registerCommunityModule(mod: CommunityIntegrationModule): void {
  communityModules.set(mod.id, mod);
}

/** Get a registered community integration module by ID. */
export function getCommunityModule(id: string): CommunityIntegrationModule | undefined {
  return communityModules.get(id);
}

/** Get all registered community integration module IDs. */
export function getCommunityModuleIds(): string[] {
  return Array.from(communityModules.keys());
}

/**
 * Initialize the global push-based registration.
 * Call once at app startup (in IntegrationProvider) to wire up
 * window.__openmapx_integrations.push() to registerCommunityModule().
 */
export function initCommunityIntegrationRegistry(): void {
  if (typeof window === "undefined") return;

  // Process any modules that were pushed before init
  const existing = window.__openmapx_integrations;
  if (Array.isArray(existing)) {
    for (const mod of existing) {
      registerCommunityModule(mod);
    }
  }

  // Replace the array with a push-intercepting proxy
  window.__openmapx_integrations = new Proxy([] as CommunityIntegrationModule[], {
    get(target, prop) {
      if (prop === "push") {
        return (...items: CommunityIntegrationModule[]) => {
          for (const mod of items) {
            registerCommunityModule(mod);
          }
          return target.push(...items);
        };
      }
      return Reflect.get(target, prop);
    },
  });
}
