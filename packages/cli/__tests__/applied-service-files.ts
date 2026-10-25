import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";

/**
 * Applies a generation for a checkout at `root` whose one built-in, `id`,
 * mounts `path` from its directory, so a build helper finds the copy the
 * generation mounts. Returns that copy's host path.
 */
export async function applyServiceFile(root: string, id: string, path: string): Promise<string> {
  const infraDir = join(root, "infra", "docker");
  await coreServices.commitConfigurationGeneration({
    infraDir,
    services: [
      {
        manifest: {
          id,
          name: id,
          version: "1.0.0",
          quality: "built-in",
          container: { image: `example/${id}`, tag: "1" },
          bindMounts: [{ source: path, target: `/config/${path}` }],
        },
        directory: join(root, "services", id),
        isBuiltIn: true,
        enabled: true,
      },
    ],
    input: {
      domain: "maps.example.test",
      selectedRoots: [id],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    },
    legacyTraefikDynamicMounted: false,
  });
  return coreServices.appliedServiceFile(infraDir, id, path);
}
