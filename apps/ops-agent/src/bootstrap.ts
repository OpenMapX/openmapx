import type { FastifyListenOptions } from "fastify";
import type { AdministrativeReleaseEffects } from "./administrative-runtime";
import { type BuildOpsAgentServerOptions, buildOpsAgentServer } from "./server";

function installGracefulShutdown(app: ReturnType<typeof buildOpsAgentServer>) {
  let closing = false,
    deadline: ReturnType<typeof setTimeout> | undefined;
  // A request active at server.close() can otherwise become an idle keep-alive
  // connection afterwards and outlive the shutdown deadline. Finish its body
  // normally, then close the connection rather than retaining it for reuse.
  app.addHook("onSend", async (_request, reply, payload) => {
    if (closing) reply.header("connection", "close");
    return payload;
  });
  const stop = () => {
    if (closing) return;
    closing = true;
    deadline = setTimeout(() => {
      process.stderr.write("ops-agent: shutdown timed out; retained work requires recovery\n");
      process.exit(1);
    }, 30_000);
    deadline.unref();
    void app.close().then(
      () => {
        if (deadline) clearTimeout(deadline);
        process.exit(0);
      },
      () => {
        if (deadline) clearTimeout(deadline);
        process.stderr.write("ops-agent: shutdown failed; retained work requires recovery\n");
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  app.addHook("onClose", async () => {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  });
}

/** Production assembly, after token and configuration authority validation. */
export async function startOpsAgentServer(
  options: BuildOpsAgentServerOptions,
  releaseEffects: Pick<AdministrativeReleaseEffects, "initialize">,
  listen: FastifyListenOptions,
  onReleaseReady?: () => void,
) {
  let ready = false;
  try {
    await releaseEffects.initialize?.();
    ready = true;
  } catch {
    // Retain the transaction for explicit reconciliation; never retry unknown effects here.
  }
  const app = buildOpsAgentServer({
    ...options,
    releaseRecovery: { ready, ...(!ready ? { reason: "recovery_required" as const } : {}) },
  });
  installGracefulShutdown(app);
  try {
    await app.listen(listen);
  } catch (error) {
    await app.close();
    throw error;
  }
  if (ready) onReleaseReady?.();
  return app;
}
