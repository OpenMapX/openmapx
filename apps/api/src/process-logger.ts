import { envString } from "@openmapx/core/server-env";
import pino from "pino";
import { appLogger } from "./services/app-logger";
import { createSafePinoOptions } from "./utils/safe-log-fields";

/**
 * The API process's one logger. It redacts credentials and URLs like every
 * request log, and writes to stdout and to the admin log stream. It exists at
 * import, so code that runs before the app is built (integration discovery,
 * secret loading) logs through it too.
 */
export const processLogger = pino(
  createSafePinoOptions(envString("LOG_LEVEL", "info")),
  pino.multistream([{ stream: process.stdout }, { stream: appLogger.createPinoStream() }]),
);
