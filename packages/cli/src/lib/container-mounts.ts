import { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";

/** Every container's bind mounts, or `undefined` when Docker can't tell. */
export async function containerBindMounts(): Promise<
  coreServices.ContainerBindMounts[] | undefined
> {
  return coreServices.readContainerBindMounts(async (args) => {
    const result = await execa("docker", args, { reject: false, timeout: 30_000 });
    if (result.exitCode !== 0) throw new Error("docker failed");
    return String(result.stdout ?? "");
  });
}
