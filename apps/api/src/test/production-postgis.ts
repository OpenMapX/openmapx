import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const { container: manifest } = JSON.parse(
  readFileSync(join(repoRoot, "services", "postgis", "service.json"), "utf8"),
) as { container: { image: string; tag: string; digest: string } };
const IMAGE = `${manifest.image}:${manifest.tag}@${manifest.digest}`;
const ENTRYPOINT = "/usr/local/bin/openmapx-postgis-entrypoint.sh";
const IMAGE_INITDB = "/docker-entrypoint-initdb.d/10_postgis.sh";

/** The API's migrations, which the API role applies to the production layout. */
export const API_MIGRATIONS = join(import.meta.dirname, "..", "db", "migrations");

/** True once PostGIS accepts connections and its entrypoint has synced the roles. */
export const PRODUCTION_POSTGIS_SYNCED =
  "pg_isready -h 127.0.0.1 -U postgres -d openmapx -q && test -f /var/run/postgresql/openmapx-password-synced";

export interface ProductionPostgisPasswords {
  superuser: string;
  api: string;
  dataManager: string;
  tiles: string;
  openConditions: string;
}

export function productionPostgisPasswords(): ProductionPostgisPasswords {
  return {
    superuser: randomBytes(24).toString("base64url"),
    api: randomBytes(32).toString("base64url"),
    dataManager: randomBytes(32).toString("base64url"),
    tiles: randomBytes(32).toString("base64url"),
    openConditions: randomBytes(32).toString("base64url"),
  };
}

/** The pinned PostGIS image running the production entrypoint, with the
 * image's own initdb script replaced and both role password files, as
 * service.json mounts them. */
export function startProductionPostgis(
  passwords: ProductionPostgisPasswords,
  environment: Record<string, string> = {},
): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(IMAGE)
    .withDatabase("openmapx")
    .withUsername("postgres")
    .withPassword(passwords.superuser)
    .withEnvironment({
      OPENMAPX_API_DB_PASSWORD_FILE: "/run/secrets/postgres-api-password",
      OPENMAPX_DATA_MANAGER_DB_PASSWORD_FILE: "/run/secrets/postgres-data-manager-password",
      ...environment,
    })
    .withCopyContentToContainer([
      {
        content: readFileSync(join(repoRoot, "services/postgis/scripts/sync-password.sh")),
        target: ENTRYPOINT,
        mode: 0o755,
      },
      {
        content: readFileSync(join(repoRoot, "services/postgis/scripts/initdb-extensions.sh")),
        target: IMAGE_INITDB,
        mode: 0o755,
      },
      { content: passwords.api, target: "/run/secrets/postgres-api-password", mode: 0o600 },
      {
        content: passwords.dataManager,
        target: "/run/secrets/postgres-data-manager-password",
        mode: 0o600,
      },
    ])
    .withEntrypoint([ENTRYPOINT])
    .withCommand(["postgres"])
    .withHealthCheck({
      test: ["CMD-SHELL", PRODUCTION_POSTGIS_SYNCED],
      interval: 250,
      timeout: 1000,
      retries: 1000,
    })
    .withStartupTimeout(120_000)
    .start();
}

/** One connection to the container as the given role, over TCP with its password. */
export function connectProductionPostgis(
  container: StartedPostgreSqlContainer,
  role: string,
  password: string,
): Sql {
  const url = new URL(container.getConnectionUri());
  url.username = role;
  url.password = password;
  return postgres(url.toString(), { max: 1, onnotice: () => {} });
}
