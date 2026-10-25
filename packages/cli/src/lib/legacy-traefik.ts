import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";

/**
 * Whether a container, running or stopped, still mounts the checkout's
 * Traefik dynamic directory, where releases before this one wrote the routes:
 * a Traefik not recreated since. `undefined` when Docker can't tell, which
 * render treats like `true`.
 */
export async function legacyTraefikDynamicMounted(infraDir: string): Promise<boolean | undefined> {
  try {
    const result = await execa(
      "docker",
      [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `volume=${coreServices.legacyTraefikDynamicDirectory(infraDir)}`,
      ],
      { reject: false, timeout: 30_000 },
    );
    if (result.exitCode !== 0) return undefined;
    return String(result.stdout ?? "").trim() !== "";
  } catch {
    return undefined;
  }
}
