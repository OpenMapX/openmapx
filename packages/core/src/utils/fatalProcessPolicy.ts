export interface FatalProcessPorts {
  fatal(fields: { err: unknown }, message: string): void;
  exit(code: 1): void;
}

/**
 * Fail-fast policy for process-level faults. Once control reaches a fatal
 * channel, no error shape proves shared application state is still safe.
 */
export function createFatalProcessHandler(ports: FatalProcessPorts): (error: unknown) => void {
  return (error) => {
    ports.fatal({ err: error }, "Fatal uncaught error — exiting");
    ports.exit(1);
  };
}
