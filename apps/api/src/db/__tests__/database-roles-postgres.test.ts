import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");
const repoRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");
const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const { container: manifest } = JSON.parse(
  readFileSync(join(repoRoot, "services", "postgis", "service.json"), "utf8"),
) as { container: { image: string; tag: string; digest: string } };
const IMAGE = `${manifest.image}:${manifest.tag}@${manifest.digest}`;
const ENTRYPOINT = "/usr/local/bin/openmapx-postgis-entrypoint.sh";
const SYNCED =
  "pg_isready -h 127.0.0.1 -U postgres -d openmapx -q && test -f /var/run/postgresql/openmapx-password-synced";
const passwords = {
  superuser: randomBytes(24).toString("base64url"),
  api: randomBytes(32).toString("base64url"),
  dataManager: randomBytes(32).toString("base64url"),
  tiles: randomBytes(32).toString("base64url"),
  openConditions: randomBytes(32).toString("base64url"),
};

let container: StartedPostgreSqlContainer;
let api: Sql;
let dataManager: Sql;
let superuser: Sql;

function connect(role: string, password: string, on = container): Sql {
  const url = new URL(on.getConnectionUri());
  url.username = role;
  url.password = password;
  return postgres(url.toString(), { max: 1, onnotice: () => {} });
}

async function permissionDenied(statement: Promise<unknown>): Promise<void> {
  await expect(statement).rejects.toMatchObject({ code: "42501" });
}

/** The pinned PostGIS image running the production entrypoint with both role password files. */
async function startPostgis(environment: Record<string, string> = {}) {
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
      test: ["CMD-SHELL", SYNCED],
      interval: 250,
      timeout: 1000,
      retries: 1000,
    })
    .withStartupTimeout(120_000)
    .start();
}

/** The production PostGIS entrypoint creates the roles before the API migrates as its own role. */
integration("database roles", () => {
  beforeAll(async () => {
    container = await startPostgis();
    superuser = connect("postgres", passwords.superuser);
    api = connect("openmapx_api", passwords.api);
    dataManager = connect("openmapx_data_manager", passwords.dataManager);
    await migrate(drizzle(api), { migrationsFolder: MIGRATIONS });
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled([api?.end(), dataManager?.end(), superuser?.end()]);
    await container?.stop();
  });

  it("migrates an empty database as the API role, which owns what it creates", async () => {
    const owners = await superuser<{ owner: string; tables: number }[]>`
      SELECT pg_get_userbyid(c.relowner) AS owner, count(*)::int AS tables
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname IN ('public', 'data_manager', 'drizzle')
        AND c.relname <> 'spatial_ref_sys'
      GROUP BY 1`;
    expect(owners).toEqual([{ owner: "openmapx_api", tables: expect.any(Number) }]);
    // The API owns its schemas; the database stays the superuser's, so the API
    // cannot change settings that superuser sessions in it inherit.
    const [database] = await superuser<{ owner: string; public: string }[]>`
      SELECT pg_get_userbyid(datdba) AS owner,
        (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS public
      FROM pg_database WHERE datname = current_database()`;
    expect(database).toEqual({ owner: "postgres", public: "openmapx_api" });
    await permissionDenied(api.unsafe("ALTER DATABASE openmapx SET search_path = public"));
  });

  it("keeps data-manager away from the API's tables", async () => {
    // Accounts, administrative jobs and the desired platform configuration.
    for (const table of [
      "user",
      "session",
      "admin_job",
      "service_config",
      "service_secret",
      "integration_config",
      "integration_secret",
      "system_settings",
      "platform_configuration_preview",
    ]) {
      const [column] = await superuser<{ name: string }[]>`
        SELECT attname AS name FROM pg_attribute
        WHERE attrelid = ${`public."${table}"`}::regclass AND attnum > 0 AND NOT attisdropped
        ORDER BY attnum LIMIT 1`;
      const name = column?.name;
      expect(name).toBeTruthy();
      await permissionDenied(
        dataManager.unsafe(`UPDATE public."${table}" SET "${name}" = "${name}" WHERE false`),
      );
      await permissionDenied(dataManager.unsafe(`SELECT 1 FROM public."${table}" LIMIT 1`));
      await permissionDenied(dataManager.unsafe(`DELETE FROM public."${table}" WHERE false`));
    }
    await permissionDenied(dataManager.unsafe("CREATE TABLE public.data_manager_probe (id int)"));
  });

  it("stops data-manager from taking a schema name another role trusts", async () => {
    expect(await api.unsafe("SHOW search_path")).toEqual([{ search_path: "public" }]);
    expect(await dataManager.unsafe("SHOW search_path")).toEqual([{ search_path: "public" }]);
    for (const name of ["openmapx_api", "conditions", "tiles_shadow", "Osm_search"])
      await permissionDenied(dataManager.unsafe(`CREATE SCHEMA "${name}"`));
    await dataManager.unsafe("CREATE SCHEMA notable_places__staging");
    await permissionDenied(
      dataManager.unsafe("ALTER SCHEMA notable_places__staging RENAME TO conditions"),
    );
    await dataManager.unsafe("DROP SCHEMA notable_places__staging");
    // The API creates only the schemas its migrations need.
    await permissionDenied(api.unsafe("CREATE SCHEMA api_probe"));
  });

  it("lets data-manager write plain views but no code that the API could run", async () => {
    // The tables and view data-manager's ambient-places build creates.
    await dataManager.unsafe(`
      CREATE SCHEMA ambient_places;
      CREATE TABLE ambient_places.generations (id uuid PRIMARY KEY, publication_status text NOT NULL);
      CREATE TABLE ambient_places.features (generation uuid NOT NULL, name text NOT NULL);
      CREATE TABLE ambient_places.planet_features (generation uuid NOT NULL, name text NOT NULL);
      INSERT INTO ambient_places.generations VALUES ('00000000-0000-4000-8000-000000000001', 'published');
      INSERT INTO ambient_places.features VALUES ('00000000-0000-4000-8000-000000000001', 'view');
      CREATE OR REPLACE VIEW ambient_places.features_all AS
        SELECT f.* FROM ambient_places.features f JOIN ambient_places.generations g ON g.id=f.generation WHERE g.publication_status='published'
        UNION ALL
        SELECT f.* FROM ambient_places.planet_features f JOIN ambient_places.generations g ON g.id=f.generation WHERE g.publication_status='published';
    `);
    expect(await api.unsafe("SELECT name FROM ambient_places.features_all")).toEqual([
      { name: "view" },
    ]);
    for (const statement of [
      "CREATE FUNCTION ambient_places.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "CREATE PROCEDURE ambient_places.probe() LANGUAGE sql AS 'SELECT 1'",
      "DO $$ BEGIN EXECUTE 'CREATE FUNCTION ambient_places.probe() RETURNS int LANGUAGE sql AS ''SELECT 1'''; END $$",
      "CREATE RULE probe AS ON INSERT TO ambient_places.features DO INSTEAD NOTHING",
      "CREATE TRIGGER probe BEFORE INSERT ON ambient_places.features FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()",
      "CREATE AGGREGATE ambient_places.probe(int) (SFUNC = int4pl, STYPE = int)",
      "CREATE POLICY probe ON ambient_places.features USING (true)",
      "CREATE MATERIALIZED VIEW ambient_places.probe AS SELECT name FROM ambient_places.features",
      "CREATE STATISTICS ambient_places.probe ON name, generation FROM ambient_places.features",
      "GRANT INSERT ON ambient_places.features TO openmapx_api",
      "COMMENT ON TABLE ambient_places.features IS 'probe'",
      // Extensions, even those PostGIS already installed.
      "CREATE EXTENSION IF NOT EXISTS pg_trgm",
      "CREATE EXTENSION tablefunc SCHEMA ambient_places",
      // Views that run SQL as their reader, call a function or an extension's
      // operator, branch, or read another schema.
      `CREATE VIEW ambient_places.leak AS SELECT query_to_xml('SELECT email FROM public."user"', true, false, '')::text AS name`,
      "CREATE VIEW ambient_places.leak AS SELECT upper(name) AS name FROM ambient_places.features",
      "CREATE VIEW ambient_places.leak AS SELECT name FROM ambient_places.features WHERE name % 'view'",
      "CREATE VIEW ambient_places.leak AS SELECT CASE WHEN name = 'a' THEN name END AS name FROM ambient_places.features",
      "CREATE VIEW ambient_places.leak AS SELECT name FROM ambient_places.features WHERE name IN (SELECT name FROM ambient_places.features)",
      'CREATE VIEW ambient_places.leak AS SELECT id AS name FROM public."user"',
      `CREATE OR REPLACE VIEW ambient_places.features_all AS
        SELECT f.* FROM ambient_places.features f WHERE length(f.name) > 0
        UNION ALL SELECT f.* FROM ambient_places.planet_features f`,
    ])
      await permissionDenied(dataManager.unsafe(statement));
    expect(await api.unsafe("SELECT name FROM ambient_places.features_all")).toEqual([
      { name: "view" },
    ]);
    await dataManager.unsafe("DROP SCHEMA ambient_places CASCADE");
  });

  it("lets data-manager change its own tables and the API prune its jobs", async () => {
    await dataManager.unsafe("SELECT count(*) FROM data_manager.jobs");
    await dataManager.unsafe(
      "INSERT INTO data_manager.jobs SELECT * FROM data_manager.jobs WHERE false",
    );
    await dataManager.unsafe("UPDATE data_manager.jobs SET status = status WHERE false");
    await dataManager.unsafe("DELETE FROM data_manager.job_stages WHERE false");
    await dataManager.unsafe(
      "UPDATE data_manager.offline_package_jobs SET status = status WHERE false",
    );
    await api.unsafe("DELETE FROM data_manager.jobs WHERE false");
  });

  it("keeps a schema data-manager builds readable by the API across a swap", async () => {
    const build = async (schema: string, label: string) => {
      await dataManager.unsafe(`
        DROP SCHEMA IF EXISTS "${schema}" CASCADE;
        CREATE SCHEMA "${schema}";
        CREATE TABLE "${schema}".places (name text NOT NULL, geom geometry(Point, 4326));
        CREATE INDEX ON "${schema}".places USING gin (name gin_trgm_ops);
        INSERT INTO "${schema}".places VALUES ('${label}', ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326));
        CREATE TABLE "${schema}".names AS SELECT name FROM "${schema}".places;
      `);
    };
    await build("osm_search__staging", "first");
    await dataManager.begin(async (tx) => {
      await tx.unsafe("ALTER SCHEMA osm_search__staging RENAME TO osm_search");
    });
    expect(await api.unsafe("SELECT name FROM osm_search.places")).toEqual([{ name: "first" }]);

    await build("osm_search__staging", "second");
    await dataManager.begin(async (tx) => {
      await tx.unsafe("ALTER SCHEMA osm_search RENAME TO osm_search__previous");
      await tx.unsafe("ALTER SCHEMA osm_search__staging RENAME TO osm_search");
      await tx.unsafe("DROP SCHEMA osm_search__previous CASCADE");
    });
    expect(await api.unsafe("SELECT name FROM osm_search.places")).toEqual([{ name: "second" }]);
    expect(await api.unsafe("SELECT name FROM osm_search.names")).toEqual([{ name: "second" }]);
    await permissionDenied(api.unsafe("INSERT INTO osm_search.places (name) VALUES ('api')"));
  });
});

/**
 * Code one role writes must never run with another role's rights: neither
 * data-manager's in the API's sessions, nor the API's in a superuser's. Each
 * case below is a reproduction of such an attempt.
 */
integration("code planted for another role", () => {
  let db: StartedPostgreSqlContainer;
  let roles: { api: Sql; dataManager: Sql; superuser: Sql };
  const open = () => {
    roles = {
      api: connect("openmapx_api", passwords.api, db),
      dataManager: connect("openmapx_data_manager", passwords.dataManager, db),
      superuser: connect("postgres", passwords.superuser, db),
    };
  };
  const close = () =>
    Promise.allSettled([roles.api.end(), roles.dataManager.end(), roles.superuser.end()]);
  /** PostGIS restarts and runs its entrypoint's superuser SQL again. */
  const restart = async () => {
    await close();
    await db.restart();
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if ((await db.exec(["sh", "-c", SYNCED])).exitCode === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    open();
  };

  beforeAll(async () => {
    db = await startPostgis({ MARTIN_DB_PASSWORD: passwords.tiles });
    open();
    await migrate(drizzle(roles.api), { migrationsFolder: MIGRATIONS });
  }, 240_000);
  afterAll(async () => {
    await close();
    await db?.stop();
  });

  it("refuses data-manager's domain whose check would change the API's search path", async () => {
    await roles.dataManager.unsafe(`
      CREATE SCHEMA osm_search;
      CREATE TABLE osm_search.places (name text);
      INSERT INTO osm_search.places VALUES ('a');
      CREATE TABLE osm_search."user" (id text, email text);
      INSERT INTO osm_search."user" VALUES ('1', 'forged@x');
    `);
    for (const statement of [
      "CREATE DOMAIN osm_search.d AS text CHECK (set_config('search_path', 'osm_search, public', false) IS NOT NULL)",
      "CREATE VIEW osm_search.v AS SELECT name::osm_search.d AS name FROM osm_search.places",
    ])
      await roles.dataManager.unsafe(statement).catch(() => undefined);
    await roles.api.unsafe("SELECT * FROM osm_search.v").catch(() => undefined);
    expect(await roles.api.unsafe("SHOW search_path")).toEqual([{ search_path: "public" }]);
    expect(await roles.api.unsafe(`SELECT email FROM "user" WHERE email = 'forged@x'`)).toEqual([]);
    for (const statement of [
      "CREATE DOMAIN osm_search.d2 AS text",
      "CREATE TYPE osm_search.kind AS ENUM ('a')",
      "CREATE TYPE osm_search.pair AS (a text, b text)",
      "CREATE TYPE osm_search.span AS RANGE (subtype = text)",
      // Coercions run the target type's code as the reader of the view.
      "CREATE VIEW osm_search.w AS SELECT 1::information_schema.cardinal_number AS n FROM osm_search.places",
      "CREATE VIEW osm_search.w AS SELECT name::text::xml AS x FROM osm_search.places",
    ])
      await permissionDenied(roles.dataManager.unsafe(statement));
    await roles.dataManager.unsafe("DROP SCHEMA osm_search CASCADE");
  });

  it("keeps the API's functions in public out of the entrypoint's superuser SQL", async () => {
    // The API owns public, so it can shadow a built-in there; the entrypoint
    // searches only the catalogs.
    await roles.api.unsafe(`
      CREATE FUNCTION public.format(fmt text, db name) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
          EXECUTE 'ALTER ROLE openmapx_api SUPERUSER';
        END IF;
        RETURN fmt;
      END $$`);
    await restart();
    expect(
      await roles.superuser`SELECT rolsuper FROM pg_roles WHERE rolname = 'openmapx_api'`,
    ).toEqual([{ rolsuper: false }]);
    await roles.api.unsafe("DROP FUNCTION public.format(text, name)");
  }, 120_000);

  it("refuses the API's domains, extensions and other schemas", async () => {
    for (const statement of [
      // A restoring superuser runs a domain's check when it reads a literal.
      "CREATE DOMAIN public.openmapx_probe_domain AS text",
      "CREATE EXTENSION hstore",
      "CREATE SCHEMA conditions",
      "CREATE SCHEMA tiles_shadow",
    ])
      await permissionDenied(roles.api.unsafe(statement));
    // What the migrations themselves create stays possible.
    await roles.api.unsafe(`
      CREATE FUNCTION public.openmapx_probe() RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT 1';
      CREATE TYPE public.openmapx_probe_kind AS ENUM ('a');
      CREATE TABLE public.openmapx_probe_table (v int CHECK (v > 0), w text CHECK (w ~ '^[a-z]+$'));
      CREATE TRIGGER openmapx_probe_trigger BEFORE UPDATE ON public.openmapx_probe_table
        FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
    `);
  });

  it("lets check constraints and generated columns run only as the table's owner", async () => {
    // Accepted, with a row each, for the restore below to load: each runs as
    // its table's owner, whose session loads the row.
    await roles.api.unsafe(`
      CREATE FUNCTION public.openmapx_escalate() RETURNS int LANGUAGE plpgsql IMMUTABLE AS $$
      BEGIN
        IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
          EXECUTE 'ALTER ROLE openmapx_api SUPERUSER';
        END IF;
        RETURN 1;
      END $$;
      CREATE TABLE public.openmapx_checked (
        v int CHECK (public.openmapx_escalate() = 1),
        p text CHECK (set_config('search_path', 'public', false) IS NOT NULL),
        g int GENERATED ALWAYS AS (public.openmapx_escalate()) STORED);
      INSERT INTO public.openmapx_checked (v, p) VALUES (1, 'a');
    `);
    // Data-manager's own tables, with checks and a PostGIS generated column.
    await roles.dataManager.unsafe(`
      CREATE SCHEMA ambient_places;
      CREATE TABLE ambient_places.state (singleton smallint PRIMARY KEY CHECK (singleton = 1));
      CREATE TABLE ambient_places.places (
        qid TEXT PRIMARY KEY CHECK (qid ~ '^Q[0-9]+$'),
        lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
        lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
        geom GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS (
          ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
        ) STORED,
        kind TEXT NOT NULL CHECK (kind IN ('place','settlement'))
      );
      ALTER TABLE ambient_places.state ADD CONSTRAINT probe
        CHECK (query_to_xml('SELECT 1', true, false, '') IS NOT NULL);
      INSERT INTO ambient_places.state VALUES (1);
      INSERT INTO ambient_places.places (qid, lat, lng, kind) VALUES ('Q1', 52.5, 13.4, 'place');
    `);
    expect(
      await roles.superuser`
        SELECT e.extname, pg_get_userbyid(e.extowner) AS owner FROM pg_extension e
        WHERE e.extname IN ('pg_trgm', 'btree_gist', 'fuzzystrmatch') ORDER BY 1`,
    ).toEqual([
      { extname: "btree_gist", owner: "postgres" },
      { extname: "fuzzystrmatch", owner: "postgres" },
      { extname: "pg_trgm", owner: "postgres" },
    ]);
    expect(
      await roles.superuser`SELECT rolsuper FROM pg_roles WHERE rolname = 'openmapx_api'`,
    ).toEqual([{ rolsuper: false }]);
  });

  it("renders a traffic tile as a role without superuser rights or table access", async () => {
    // OpenConditions installed after PostGIS started, as its own role.
    await roles.superuser.unsafe(`
      CREATE ROLE openconditions_fixture LOGIN PASSWORD '${passwords.openConditions}';
      GRANT CREATE ON DATABASE openmapx TO openconditions_fixture;
    `);
    const openConditions = connect("openconditions_fixture", passwords.openConditions, db);
    try {
      await openConditions.unsafe(`
        CREATE SCHEMA conditions;
        CREATE TABLE conditions.road_segment (segment_id text, geom geometry(LineString, 4326));
        CREATE TABLE conditions.segment_speed (segment_id text);
        CREATE TABLE conditions.source (id text);
        INSERT INTO conditions.road_segment VALUES
          ('s1', ST_SetSRID(ST_MakeLine(ST_MakePoint(-1, -1), ST_MakePoint(1, 1)), 4326));
        -- Like OpenConditions' own: invoker's rights, PostGIS called unqualified.
        CREATE FUNCTION conditions.segment_flow(z integer, x integer, y integer, query_params json)
          RETURNS bytea LANGUAGE plpgsql STABLE AS $$
          DECLARE bounds geometry := ST_TileEnvelope(z, x, y); n integer;
          BEGIN
            SELECT count(*) INTO n FROM conditions.road_segment s
              WHERE s.geom && ST_Transform(bounds, 4326);
            RETURN convert_to(concat_ws(' ', current_user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), n), 'UTF8');
          END $$;
      `);
    } finally {
      await openConditions.end();
    }
    const tile = async () => {
      const martin = connect("openmapx_tiles", passwords.tiles, db);
      try {
        const [row] = await martin<{ tile: string }[]>`
          SELECT convert_from(tiles.segment_flow(0, 0, 0, '{}'), 'UTF8') AS tile`;
        return row?.tile;
      } finally {
        await martin.end();
      }
    };
    // Until PostGIS grants the tile function's role access, a tile fails
    // visibly and nothing runs with more rights.
    await permissionDenied(tile());
    await restart();
    expect(await tile()).toBe("openmapx_tiles_owner f 1");
    const martin = connect("openmapx_tiles", passwords.tiles, db);
    try {
      // PostGIS's coordinate-system catalogue, spatial_ref_sys, stays readable by
      // every role: PostGIS reads it for each transformation.
      for (const table of ["conditions.road_segment", "conditions.source", 'public."user"'])
        await permissionDenied(martin.unsafe(`SELECT 1 FROM ${table} LIMIT 1`));
    } finally {
      await martin.end();
    }
    // An overload in public, planted past the role guard, runs with the tile
    // role's rights at most.
    await roles.superuser.unsafe(`
      CREATE FUNCTION public.st_tileenvelope(z integer, x integer, y integer) RETURNS geometry
        LANGUAGE plpgsql AS $$
        BEGIN
          EXECUTE 'ALTER ROLE openmapx_api SUPERUSER';
          RETURN ST_MakeEnvelope(-180, -90, 180, 90, 4326);
        END $$;
      ALTER FUNCTION public.st_tileenvelope(integer, integer, integer) OWNER TO openmapx_api;
    `);
    await tile().catch(() => undefined);
    expect(
      await roles.superuser`SELECT rolsuper FROM pg_roles WHERE rolname = 'openmapx_api'`,
    ).toEqual([{ rolsuper: false }]);
    await roles.superuser.unsafe("DROP FUNCTION public.st_tileenvelope(integer, integer, integer)");
  }, 180_000);

  it("restores a backup with every owner, grant and guard intact", async () => {
    await roles.dataManager.unsafe(`
      CREATE SCHEMA osm_search;
      CREATE TABLE osm_search.places (name text);
      INSERT INTO osm_search.places VALUES ('kept');
    `);
    await roles.api.unsafe(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('restored', 'Restored', 'restored@example.test', true, now(), now())`,
    );
    // Each role's check constraint calls a superuser's PostGIS function that
    // runs the SQL it is given; loading the row runs it as whoever loads it.
    await roles.api.unsafe(`
      CREATE FUNCTION public.openmapx_pwn() RETURNS int LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
          EXECUTE 'ALTER ROLE openmapx_api SUPERUSER';
        END IF;
        RETURN 1;
      END $$;
      CREATE VIEW data_manager.pwnv AS
        SELECT 'POINT(0 0)'::public.geometry AS g, public.openmapx_pwn() AS x;
      CREATE TABLE public.harmless (id int, CHECK (pg_catalog.length(COALESCE(
        public.st_findextent('data_manager', 'pwnv', 'g')::text, '')) >= 0));
      INSERT INTO public.harmless VALUES (1);
    `);
    await roles.dataManager.unsafe(`
      CREATE TABLE osm_search.planted (id int, CHECK (pg_catalog.length(COALESCE(public.st_findextent('osm_search', 't',
        'g") AS extent FROM (SELECT NULL::public.geometry AS g) s WHERE CASE WHEN (SELECT rolsuper FROM pg_catalog.pg_roles
         WHERE rolname = current_user) THEN pg_catalog.lo_from_bytea(4242, ''pwn'')::int ELSE 0 END >= 0 --')::text, '')) >= 0));
      INSERT INTO osm_search.planted VALUES (1);
    `);
    await close();
    const run = async (command: string[], label: string) => {
      const result = await db.exec(command);
      expect(result.exitCode, `${label}: ${result.stderr}`).toBe(0);
      return result.output;
    };
    const superuserPsql = ["env", `PGOPTIONS=${services.SUPERUSER_PGOPTIONS}`, "psql", "-X"];
    const query = (sql: string) =>
      run(
        [
          ...superuserPsql,
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "--no-align",
          "--tuples-only",
          "-c",
          sql,
        ],
        sql,
      );
    // The CLI's restore: dump through a pipe, read the live database's owner
    // and grants, recreate the database, give them back, then restore each
    // entry in a session of its owner.
    await run(
      ["sh", "-c", "pg_dump --format=custom -U postgres openmapx | cat > /tmp/openmapx.dump"],
      "dump",
    );
    const settings = await query(services.databaseSettingsQuery("openmapx"));
    expect(settings).toContain("GRANT CREATE ON DATABASE openmapx TO openmapx_data_manager;");
    await run(["dropdb", "-U", "postgres", "--force", "openmapx"], "dropdb");
    await run(["createdb", "-U", "postgres", "openmapx"], "createdb");
    await db.copyContentToContainer([{ content: settings, target: "/tmp/settings.sql" }]);
    await run(
      [
        ...superuserPsql,
        "-v",
        "ON_ERROR_STOP=1",
        "--single-transaction",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-f",
        "/tmp/settings.sql",
      ],
      "settings apply",
    );
    const list = (section: string) =>
      run(["sh", "-c", `pg_restore --list --section=${section} < /tmp/openmapx.dump`], section);
    const passes = services.planOwnerRestore(
      {
        preData: await list("pre-data"),
        data: await list("data"),
        postData: await list("post-data"),
      },
      await query(services.RESTORE_ROLES_QUERY),
    );
    // Each role restores its own entries; the superuser's event triggers
    // come last.
    const sessions = new Set(
      passes.map(({ role, section }) => `${section} ${role ?? "superuser"}`),
    );
    expect([...sessions].sort()).toEqual([
      "data openconditions_fixture",
      "data openmapx_api",
      "data openmapx_data_manager",
      "data superuser",
      "post-data openmapx_api",
      "post-data openmapx_data_manager",
      "post-data superuser",
      "pre-data openconditions_fixture",
      "pre-data openmapx_api",
      "pre-data openmapx_data_manager",
      "pre-data superuser",
    ]);
    expect(passes.at(-1)).toMatchObject({ role: null, section: "post-data" });
    for (const [index, pass] of passes.entries()) {
      const preamble = `/tmp/preamble-${index}`;
      await db.copyContentToContainer([
        { content: services.restorePassPreamble(pass), target: preamble },
      ]);
      await run(
        [
          "sh",
          "-c",
          'cat "$0" /tmp/openmapx.dump | "$@"',
          preamble,
          ...services.restorePassCommand(pass, "postgres", "openmapx"),
        ],
        `${pass.section} as ${pass.role ?? "superuser"}`,
      );
    }
    open();
    // Every row came back, and loading them ran no role's code as the superuser.
    expect(
      await roles.superuser`
        SELECT (SELECT count(*)::int FROM public.harmless) AS api_rows,
          (SELECT count(*)::int FROM osm_search.planted) AS data_manager_rows,
          (SELECT array_agg(rolname ORDER BY rolname) FROM pg_roles
            WHERE rolsuper AND rolname <> 'postgres') AS superusers,
          (SELECT count(*)::int FROM pg_largeobject_metadata) AS large_objects`,
    ).toEqual([{ api_rows: 1, data_manager_rows: 1, superusers: null, large_objects: 0 }]);
    expect(
      await roles.superuser`
        SELECT pg_get_userbyid(d.datdba) AS database,
          (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS public,
          (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'osm_search') AS index,
          (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public."user"'::regclass) AS users,
          (SELECT pg_get_userbyid(proowner) FROM pg_proc
            WHERE oid = 'tiles.segment_flow(integer, integer, integer, json)'::regprocedure) AS tiles,
          (SELECT array_agg(evtname ORDER BY evtname) FROM pg_event_trigger) AS guards,
          has_database_privilege('openmapx_data_manager', d.datname, 'CREATE') AS data_manager_create,
          has_table_privilege('openmapx_tiles_owner', 'conditions.road_segment', 'SELECT') AS tile_read
        FROM pg_database d WHERE d.datname = 'openmapx'`,
    ).toEqual([
      {
        database: "postgres",
        public: "openmapx_api",
        index: "openmapx_data_manager",
        users: "openmapx_api",
        tiles: "openmapx_tiles_owner",
        guards: ["openmapx_guard_check_ddl", "openmapx_guard_refuse_code"],
        data_manager_create: true,
        tile_read: true,
      },
    ]);
    expect(await roles.api.unsafe("SELECT name FROM osm_search.places")).toEqual([
      { name: "kept" },
    ]);
    await permissionDenied(roles.dataManager.unsafe(`SELECT 1 FROM "user"`));
    await permissionDenied(roles.dataManager.unsafe("CREATE SCHEMA conditions_shadow"));
    // The CLI changes API tables as the API's role, over PostGIS's local socket.
    await run(
      [
        "psql",
        "-X",
        "-U",
        "openmapx_api",
        "-d",
        "openmapx",
        "-c",
        `DELETE FROM "user" WHERE id = 'restored'`,
      ],
      "API role over the socket",
    );
  }, 180_000);
});
