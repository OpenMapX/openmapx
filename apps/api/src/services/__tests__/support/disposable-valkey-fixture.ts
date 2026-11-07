import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import Redis from "ioredis";
import redisService from "../../../../../../services/redis/service.json";
import {
  type ExtensionValkeyFixtureRuntime,
  stopExtensionValkeyFixture,
} from "../extension-store-valkey-cleanup";

// testcontainers is already the dependency of @testcontainers/postgresql.
// Resolve through that package, without adding a root/API dependency. These
// narrow types come from its actual base-class method signatures.
type Started = Pick<StartedPostgreSqlContainer, "getMappedPort" | "getHost" | "stop">;
type Builder = Pick<
  PostgreSqlContainer,
  | "withCommand"
  | "withExposedPorts"
  | "withPullPolicy"
  | "withWaitStrategy"
  | "withStartupTimeout"
  | "withAutoCleanup"
  | "withAutoRemove"
> & {
  hostConfig: { PortBindings?: Record<string, { HostIp?: string; HostPort: string }[]> };
  start(): Promise<Started>;
};

export async function createDisposableValkeyFixture() {
  const require = createRequire(import.meta.url);
  const fromPostgres = createRequire(require.resolve("@testcontainers/postgresql"));
  const { GenericContainer, Wait, PullPolicy, getContainerRuntimeClient } = fromPostgres(
    "testcontainers",
  ) as {
    GenericContainer: new (image: string) => Builder;
    getContainerRuntimeClient(): Promise<ExtensionValkeyFixtureRuntime>;
    Wait: {
      forLogMessage(message: RegExp): Parameters<PostgreSqlContainer["withWaitStrategy"]>[0];
    };
    PullPolicy: { neverPull(): Parameters<PostgreSqlContainer["withPullPolicy"]>[0] };
  };
  let createdId: string | undefined;
  const runtime = await getContainerRuntimeClient();
  class LoopbackValkey extends GenericContainer {
    constructor() {
      super(
        `${redisService.container.image}:${redisService.container.tag}@${redisService.container.digest}`,
      );
      this.withExposedPorts(6379);
      // testcontainers 12.2's public port API has no HostIp option. Its protected
      // hostConfig is available to subclasses; retain ephemeral port 0.
      this.hostConfig.PortBindings = { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] };
    }
    async containerCreated(id: string) {
      createdId = id;
    }
  }
  let container: Started | undefined;
  let client: Redis | undefined;
  const stop = () => stopExtensionValkeyFixture({ client, container, createdId, runtime });
  try {
    container = await new LoopbackValkey()
      .withCommand(["valkey-server", "--save", "", "--appendonly", "no"])
      .withPullPolicy(PullPolicy.neverPull())
      // Avoid a Ryuk/helper image pull; this exclusively owned fixture uses finally cleanup.
      .withAutoCleanup(false)
      .withAutoRemove(false)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(30_000)
      .start();
    if (!["127.0.0.1", "localhost", "::1"].includes(container.getHost())) {
      throw new Error("Extension fixture requires a local Docker runtime");
    }
    const prefix = `fixture:${randomUUID()}:`;
    const options = {
      host: "127.0.0.1",
      port: container.getMappedPort(6379),
      keyPrefix: prefix,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      autoResendUnfulfilledCommands: false,
      connectTimeout: 5_000,
    };
    client = new Redis(options);
    await client.connect();
    return { client, options, prefix, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
