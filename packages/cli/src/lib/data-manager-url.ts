/**
 * Where the CLI reaches the data-manager from the host: `DATA_MANAGER_URL`, or
 * else its published loopback port (`DATA_MANAGER_HOST_PORT`, default 4000).
 *
 * Read on each call, never at module load: `infra/docker/.env` is loaded after
 * the command modules are imported. Prefer `DATA_MANAGER_HOST_PORT` in `.env`
 * to move the port — `DATA_MANAGER_URL` there also reaches `app-api`, which
 * must keep using the in-network `http://data-manager:4000`.
 */
export function dataManagerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DATA_MANAGER_URL?.trim();
  if (explicit) return explicit;
  const port = env.DATA_MANAGER_HOST_PORT?.trim() || "4000";
  return `http://localhost:${port}`;
}
