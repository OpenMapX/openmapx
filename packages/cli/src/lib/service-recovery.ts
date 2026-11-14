import {
  closeControlInstallation,
  openControlInstallation,
  recoverServiceLifecycleByKey,
} from "@openmapx/core/build-artifacts";
import { createDataManagerTransport } from "@openmapx/core/data-manager-sdk";
import { services } from "@openmapx/core/server";
import { cliControlContext } from "./control-context";
import { cliDataManagerToken } from "./data-manager-token";
import { dataManagerUrl } from "./data-manager-url";
import { repoPaths } from "./paths";

export async function recoverServiceUpdate(options: { rootDir?: string; operationKey: string }) {
  if (cliControlContext()) throw Error("Recovery requires the installation host");
  const paths = repoPaths(options.rootDir),
    registry = new services.ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  const installation = openControlInstallation({
    infraDir: paths.infraDir,
    role: "host-cli",
    serviceIds: registry
      .list()
      .map((service) => service.manifest.id)
      .sort(),
  });
  try {
    return await recoverServiceLifecycleByKey({
      infraDir: paths.infraDir,
      installation,
      operationKey: options.operationKey,
      transport: createDataManagerTransport({
        baseUrl: dataManagerUrl(),
        authToken: cliDataManagerToken(),
        requestTimeoutMs: 15000,
        maxJsonBytes: 65536,
      }),
    });
  } finally {
    closeControlInstallation(installation);
  }
}
