import { envString } from "@openmapx/core/server-env";
import pino from "pino";
import { currentIntegrationScope } from "./integration-scope";
import { appLogger } from "./services/app-logger";
import { createSafePinoOptions } from "./utils/safe-log-fields";

/**
 * The API process's one logger. It redacts credentials and URLs like every
 * request log, and writes to stdout and to the admin log stream. It exists at
 * import, so code that runs before the app is built (integration discovery,
 * secret loading) logs through it too. A line written while an integration's
 * code runs names that integration, also through the request loggers derived
 * from it.
 */
export const processLogger = pino(
  {
    ...createSafePinoOptions(envString("LOG_LEVEL", "info")),
    mixin() {
      const scope = currentIntegrationScope();
      return scope ? { integrationId: scope.integrationId } : {};
    },
  },
  pino.multistream([{ stream: process.stdout }, { stream: appLogger.createPinoStream() }]),
);
