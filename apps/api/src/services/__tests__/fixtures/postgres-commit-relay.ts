/** External PostgreSQL transport edge for native API death probes. Only the
 * real backend's selected COMMIT or INSERT acknowledgement is held. SQL bytes, execution and
 * durable tuples are never replaced; credentials/packets are never logged. */
import { connect, createServer, type Socket } from "node:net";

export async function postgresCommitRelay(
  database: URL,
  shouldHold: (observation: { backendPid: number; command: string }) => Promise<boolean>,
  options: {
    holdCommand?: "COMMIT" | "INSERT" | "UPDATE" | "API_TERMINAL_UPDATE";
    observeFrontend?: "service-secret-insert";
  } = {},
) {
  if (database.hostname !== "127.0.0.1" || !/^\d+$/.test(database.port))
    throw Error("Explicit owned local PostgreSQL required");
  const reached = Promise.withResolvers<void>(),
    sockets = new Set<Socket>(),
    releases = new Set<() => void>();
  let retained = false,
    released = false;
  const server = createServer((client) => {
    const backend = connect({ host: database.hostname, port: Number(database.port) });
    sockets.add(client);
    sockets.add(backend);
    let pending = Buffer.alloc(0),
      suspended = false,
      held: Buffer[] = [],
      backendPid: number | undefined;
    const flush = () => {
      if (!client.destroyed && held.length) client.write(Buffer.concat(held));
      held = [];
      suspended = false;
      if (!backend.destroyed) backend.resume();
    };
    releases.add(flush);
    let frontend = Buffer.alloc(0),
      startup = true,
      frontendSuspended = false,
      observedSecretInsert = false;
    const forwardFrontend = () => {
      if (!backend.destroyed && frontend.length) backend.write(frontend);
      frontend = Buffer.alloc(0);
      frontendSuspended = false;
      client.resume();
    };
    releases.add(forwardFrontend);
    client.on("data", (bytes) => {
      if (options.holdCommand !== "API_TERMINAL_UPDATE" && !options.observeFrontend) {
        if (!backend.destroyed) backend.write(bytes);
        return;
      }
      frontend = Buffer.concat([frontend, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
      if (frontendSuspended) return;
      while (frontend.length >= (startup ? 4 : 5)) {
        const size = frontend.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (size < 5 || size > 16 * 1024 * 1024) {
          client.destroy();
          backend.destroy();
          return;
        }
        if (frontend.length < size) return;
        const packet = frontend.subarray(0, size);
        const secretInsert =
          options.observeFrontend === "service-secret-insert" &&
          !observedSecretInsert &&
          packet.includes(Buffer.from('insert into "service_secret"'));
        if (
          !startup &&
          !retained &&
          !released &&
          backendPid !== undefined &&
          (packet[0] === 0x50 || packet[0] === 0x51) &&
          (secretInsert ||
            (options.holdCommand === "API_TERMINAL_UPDATE" &&
              packet.includes(Buffer.from('update "admin_job" set "status"'))))
        ) {
          if (secretInsert) observedSecretInsert = true;
          frontendSuspended = true;
          client.pause();
          void shouldHold({
            backendPid,
            command: secretInsert ? "BEFORE_SERVICE_SECRET_INSERT" : "API_TERMINAL_UPDATE",
          })
            .then((yes) => {
              if (!secretInsert && yes && !retained && !released) {
                retained = true;
                reached.resolve();
              } else forwardFrontend();
            })
            .catch(() => {
              client.destroy();
              backend.destroy();
            });
          return;
        }
        startup = false;
        frontend = frontend.subarray(size);
        if (!backend.destroyed) backend.write(packet);
      }
    });
    client.on("close", () => {
      sockets.delete(client);
      releases.delete(flush);
      releases.delete(forwardFrontend);
      backend.destroy();
    });
    client.on("error", () => backend.destroy());
    backend.on("error", () => client.destroy());
    backend.on("close", () => {
      sockets.delete(backend);
      client.destroy();
    });
    backend.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (suspended) {
        held.push(bytes);
        return;
      }
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 5) {
        const size = pending.readInt32BE(1) + 1;
        if (size < 5 || size > 16 * 1024 * 1024) {
          client.destroy();
          backend.destroy();
          return;
        }
        if (pending.length < size) return;
        const packet = pending.subarray(0, size);
        pending = pending.subarray(size);
        if (packet[0] === 0x4b && size === 13) backendPid = packet.readInt32BE(5);
        const command = packet[0] === 0x43 ? packet.subarray(5, -1).toString() : null,
          selected =
            options.holdCommand === "API_TERMINAL_UPDATE"
              ? false
              : options.holdCommand === "UPDATE"
                ? command?.startsWith("UPDATE ")
                : options.holdCommand === "INSERT"
                  ? command?.startsWith("INSERT ")
                  : command === "COMMIT";
        if (!retained && !released && selected && command && backendPid !== undefined) {
          suspended = true;
          backend.pause();
          held = [packet, pending];
          pending = Buffer.alloc(0);
          void shouldHold({ backendPid, command })
            .then((yes) => {
              if (yes && !retained && !released) {
                retained = true;
                reached.resolve();
              } else flush();
            })
            .catch(() => {
              client.destroy();
              backend.destroy();
            });
          return;
        }
        if (!client.destroyed) client.write(packet);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Owned PostgreSQL relay unavailable");
  const url = new URL(database);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  url.searchParams.set("sslmode", "disable");
  return {
    databaseUrl: url.toString(),
    reached: reached.promise,
    release() {
      released = true;
      for (const flush of releases) flush();
    },
    async close() {
      released = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
