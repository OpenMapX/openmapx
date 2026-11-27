import { stopEventLoopWatchdog } from "./event-loop-watchdog";
import { currentIntegrationScope } from "./integration-scope";
import { markCleanStop, recordFatal } from "./safe-mode";

/**
 * The installed integration a fatal error came from. What reaches the fatal
 * handlers from an integration is work the host could not wrap, such as an
 * un-awaited promise or a timer callback, which still runs in the
 * integration's async context. A built-in integration belongs to no
 * extension that could be disabled, so its crash is recorded without a name.
 */
export function fatalIntegrationId(): string | null {
  const scope = currentIntegrationScope();
  return scope && !scope.isBuiltIn ? scope.integrationId : null;
}

/** The handler for `uncaughtException` and `unhandledRejection`: record, then exit. */
export function createFatalHandler(
  exitFatally: (error: unknown) => void,
): (error: unknown) => void {
  return (error) => {
    recordFatal(fatalIntegrationId());
    exitFatally(error);
  };
}

/**
 * The handler for a stop request that arrives before the API serves. Every
 * signal marks the stop and stops the watchdog first, also one that arrives
 * after a first signal came before the boot marker existed, so a stop is
 * never counted as a crash nor ended by a kill. The first signal cancels the
 * running migrations and then exits.
 */
export function createStartupStopHandler(options: {
  cancel: () => Promise<unknown>;
  exit: (code: number) => void;
  log: { warn(fields: object, message: string): void };
}): { onSignal(signal: NodeJS.Signals): void; requested(): boolean } {
  let stopping = false;
  return {
    onSignal(signal) {
      markCleanStop();
      stopEventLoopWatchdog();
      if (stopping) return;
      stopping = true;
      options.log.warn({ signal }, "Stopping before startup finished");
      void options.cancel().finally(() => options.exit(signal === "SIGTERM" ? 143 : 130));
    },
    requested: () => stopping,
  };
}
