import type { FastifyListenOptions } from "fastify";
import { readCapabilityKey, type TransitousRunnerOptions } from "./runner";
import { buildTransitousRunnerServer } from "./server";

interface RunnerBootstrapOptions extends Omit<TransitousRunnerOptions, "capabilityKey"> {
  capabilityKeyFile: string;
}

/** Install shutdown handling before key loading or asynchronous startup. */
export async function startTransitousRunner(
  options: RunnerBootstrapOptions,
  listen: FastifyListenOptions,
) {
  let app: ReturnType<typeof buildTransitousRunnerServer> | undefined;
  let startup: Promise<string> | undefined;
  let shutdown: Promise<void> | undefined;
  const close = () => {
    shutdown ??= (async () => {
      // Fastify registers preClose while preparing the listener.
      await startup?.catch(() => undefined);
      await app?.close();
    })();
    return shutdown;
  };
  const stop = () => {
    void close().catch(() => {
      process.stderr.write("transitous-runner failed to stop\n");
      process.exitCode = 1;
    });
  };
  // Retain the handlers so repeated signals cannot interrupt containment.
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const { capabilityKeyFile, ...runnerOptions } = options;
    app = buildTransitousRunnerServer({
      ...runnerOptions,
      capabilityKey: readCapabilityKey(capabilityKeyFile),
    });
    startup = app.listen(listen);
    await startup;
    return app;
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
