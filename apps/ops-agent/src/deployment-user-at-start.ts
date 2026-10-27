import { services } from "@openmapx/core/server";

/**
 * What the agent's log says about the deployment's user when it starts. The
 * generations the agent writes require UID and GID in `infra/docker/.env`,
 * which only a render on the host writes: the agent reads them and never
 * changes `.env`. Never throws, so the agent stays up and the admin panel can
 * show the problem; every render and commit checks again and refuses.
 */
export function describeDeploymentUserAtStart(infraDir: string): string[] {
  try {
    services.assertRunningAsDeploymentUser(
      services.readDeploymentUser(infraDir),
      "The operations agent",
    );
    return [];
  } catch (error) {
    return [(error as Error).message];
  }
}
