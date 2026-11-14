/** Fixed production installation; journal records are locators, never authority. */
import type { ControlInstallation } from "@openmapx/core/build-artifacts";
import type { OpsJobJournal } from "./journal";
import { bindCoordinatorStagedOwnershipSource } from "./owned-services";
import { productionOwnedServices } from "./production-runtime";
import type { OpsRuntime } from "./runtime";

export function installCoordinatorStagedOwnershipSource(
  runtime: OpsRuntime,
  installation: ControlInstallation,
  journal: OpsJobJournal,
): void {
  bindCoordinatorStagedOwnershipSource(productionOwnedServices(runtime), installation, journal);
}
