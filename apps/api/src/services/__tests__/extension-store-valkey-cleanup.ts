import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export interface ExtensionValkeyFixtureRuntime {
  container: {
    getById(id: string): { remove(options: { force: boolean; v: boolean }): Promise<unknown> };
  };
}

// Only for this no-Ryuk fixture. A failed start may have created a container
// without returning its started handle; ownership comes from its creation hook.
export async function stopExtensionValkeyFixture({
  client,
  container,
  createdId,
  runtime,
}: {
  client?: { disconnect(): void };
  container?: {
    stop(options: Parameters<StartedPostgreSqlContainer["stop"]>[0]): Promise<unknown>;
  };
  createdId?: string;
  runtime: ExtensionValkeyFixtureRuntime;
}): Promise<void> {
  client?.disconnect();
  if (container) await container.stop({ timeout: 0, remove: true, removeVolumes: true });
  else if (createdId) {
    await runtime.container.getById(createdId).remove({ force: true, v: true });
  }
}
