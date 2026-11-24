import { readFileSync } from "node:fs";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachFeatureStorage,
  createFeatureStorage,
  dropRetiredFeatureStorage,
  featureTable,
  retireAmbientGenerations,
} from "../../../../../services/data-manager/src/jobs/ambient-places/feature-storage.js";
import {
  AMBIENT_SCHEMA_VERSION,
  ensureAmbientSchema,
} from "../../../../../services/data-manager/src/jobs/ambient-places/schema.js";
import { buildPublicationFenceDDL } from "../../../../../services/data-manager/src/jobs/publication-fence.js";
import { publishSchemaSwap } from "../../../../../services/data-manager/src/jobs/publish-schema-swap.js";
import {
  connectProductionPostgis,
  API_MIGRATIONS as MIGRATIONS,
  productionPostgisPasswords,
  PRODUCTION_POSTGIS_SYNCED as SYNCED,
  startProductionPostgis,
} from "../../test/production-postgis";

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");
const TRAFFIC_FLOW = join(import.meta.dirname, "fixtures", "openconditions-traffic-flow.sql");
/** What `conditions.grant_consumer_roles()` grants the tile function's role:
 * the tables `conditions.segment_flow` reads, and nothing else. */
const TILE_CONTRACT_TABLES = ["public_license_policy", "road_segment", "segment_speed", "source"];
const passwords = productionPostgisPasswords();

let container: StartedPostgreSqlContainer;
let api: Sql;
let dataManager: Sql;
let superuser: Sql;

function connect(role: string, password: string, on = container): Sql {
  return connectProductionPostgis(on, role, password);
}

async function permissionDenied(statement: Promise<unknown>): Promise<void> {
  await expect(statement).rejects.toMatchObject({ code: "42501" });
}

function startPostgis(environment: Record<string, string> = {}) {
  return startProductionPostgis(passwords, environment);
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

  it("installs the extensions into a schema only the superuser can change", async () => {
    expect(
      await superuser`
        SELECT e.extname AS name, n.nspname AS schema, pg_get_userbyid(e.extowner) AS owner
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname <> 'plpgsql' ORDER BY 1`,
    ).toEqual(
      ["btree_gist", "fuzzystrmatch", "pg_trgm", "postgis"].map((name) => ({
        name,
        schema: "extensions",
        owner: "postgres",
      })),
    );
    expect(
      await superuser`
        SELECT count(*)::int AS objects FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
        WHERE d.deptype = 'e' AND d.classid = 'pg_proc'::regclass
          AND (SELECT pronamespace FROM pg_proc WHERE oid = d.objid) = 'public'::regnamespace`,
    ).toEqual([{ objects: 0 }]);
    expect(
      await superuser`
        SELECT pg_get_userbyid(nspowner) AS owner,
          has_schema_privilege('openmapx_api', oid, 'USAGE') AS api_usage,
          has_schema_privilege('openmapx_api', oid, 'CREATE') AS api_create,
          has_schema_privilege('openmapx_data_manager', oid, 'CREATE') AS data_manager_create,
          has_schema_privilege('openmapx_tiles', oid, 'CREATE') AS tiles_create
        FROM pg_namespace WHERE nspname = 'extensions'`,
    ).toEqual([
      {
        owner: "postgres",
        api_usage: true,
        api_create: false,
        data_manager_create: false,
        tiles_create: false,
      },
    ]);
    await permissionDenied(
      api.unsafe(
        "CREATE FUNCTION extensions.openmapx_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      ),
    );
    // The image's add-ons that nothing uses are never installed.
    expect(
      await superuser`
        SELECT (SELECT array_agg(nspname ORDER BY nspname) FROM pg_namespace
            WHERE nspname IN ('topology', 'tiger', 'tiger_data')) AS schemas,
          (SELECT array_agg(datname ORDER BY datname) FROM pg_database
            WHERE datname NOT IN ('postgres', 'openmapx', 'template0', 'template1')) AS databases`,
    ).toEqual([{ schemas: null, databases: null }]);
  });

  it("gives each role its search path and data-manager an idle-transaction limit", async () => {
    expect(await api.unsafe("SHOW search_path")).toEqual([{ search_path: "public, extensions" }]);
    expect(await dataManager.unsafe("SHOW search_path")).toEqual([{ search_path: "extensions" }]);
    expect(await dataManager.unsafe("SHOW idle_in_transaction_session_timeout")).toEqual([
      { idle_in_transaction_session_timeout: "10min" },
    ]);
    expect(await api.unsafe("SHOW idle_in_transaction_session_timeout")).toEqual([
      { idle_in_transaction_session_timeout: "0" },
    ]);
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
      "system_secret",
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

  it("the guard refuses a schema outside the pattern", async () => {
    // Each schema data-manager builds, publishes or keeps as the previous copy.
    for (const name of [
      "osm_search",
      "osm_search__staging",
      "osm_search__previous",
      "notable_places",
      "notable_places__staging",
      "notable_places__previous",
      "overture_places",
      "overture_places__staging",
      "overture_places__previous",
      "ambient_places",
      "overture_embeddings",
    ]) {
      await dataManager.unsafe(`CREATE SCHEMA "${name}"`);
      await dataManager.unsafe(`DROP SCHEMA "${name}"`);
    }
    // Overture's ODbL themes, which the places schema must never mix with,
    // and copies no build makes.
    for (const name of [
      "overture_buildings",
      "overture_transportation",
      "overture_divisions",
      "overture_base",
      "overture_places_extra",
      "overture_embeddings__staging",
      "ambient_places__previous",
      "osm_search__old",
    ])
      await permissionDenied(dataManager.unsafe(`CREATE SCHEMA "${name}"`));
    await dataManager.unsafe("CREATE SCHEMA overture_places__staging");
    await permissionDenied(
      dataManager.unsafe("ALTER SCHEMA overture_places__staging RENAME TO overture_buildings"),
    );
    await dataManager.unsafe("DROP SCHEMA overture_places__staging");
  });

  it("ensureAmbientSchema and the partition lifecycle succeed under the guard", async () => {
    await ensureAmbientSchema(dataManager);
    // Another data-manager process checks the version and creates nothing.
    const second = connect("openmapx_data_manager", passwords.dataManager);
    try {
      await ensureAmbientSchema(second);
    } finally {
      await second.end({ timeout: 2 });
    }
    expect(
      await superuser`
        SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
        WHERE c.relnamespace = 'ambient_places'::regnamespace`,
    ).toEqual([{ owner: "openmapx_data_manager" }]);
    expect(
      await api.unsafe("SELECT singleton, enabled, schema_version FROM ambient_places.state"),
    ).toEqual([{ singleton: 1, enabled: true, schema_version: AMBIENT_SCHEMA_VERSION }]);
    // A generation is created, filled, attached, retired, detached and dropped.
    const generation = "00000000-0000-4000-8000-0000000000a1";
    await dataManager.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO ambient_places.generations(id,manifest,storage,publication_status,cache_lease_until) VALUES($1,'{}','regional','published',now()-interval '1 second')`,
        [generation],
      );
      await createFeatureStorage(tx, generation);
      await tx.unsafe(
        `INSERT INTO ${featureTable(generation)}(generation,id,name,category,rank,min_zoom,tenant,sources,geom)
         VALUES($1,'osm:node/1','Clinic','hospital',1,13,false,'osm',ST_Transform(ST_SetSRID(ST_MakePoint(6.08,50.77),4326),3857))`,
        [generation],
      );
      await attachFeatureStorage(tx, generation);
    });
    // A planet candidate is staged under its own name and renamed as it is attached.
    const candidate = "00000000-0000-4000-8000-0000000000b1";
    await dataManager.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO ambient_places.generations(id,manifest,storage,publication_status) VALUES($1,'{}','planet','staging')`,
        [candidate],
      );
      await createFeatureStorage(tx, candidate, "candidate");
      await tx.unsafe(
        `INSERT INTO ${featureTable(candidate, "candidate")}(generation,id,name,category,rank,min_zoom,tenant,sources,geom)
         VALUES($1,'osm:node/2','Pharmacy','pharmacy',1,13,false,'osm',ST_Transform(ST_SetSRID(ST_MakePoint(6.09,50.78),4326),3857))`,
        [candidate],
      );
    });
    await dataManager.begin(async (tx) => {
      await attachFeatureStorage(tx, candidate, { from: "candidate" });
      await tx.unsafe(
        `UPDATE ambient_places.generations SET publication_status='published',cache_lease_until=now()-interval '1 second' WHERE id=$1`,
        [candidate],
      );
    });
    expect(
      await api.unsafe(
        "SELECT id, ST_SRID(geom) AS srid FROM ambient_places.features WHERE generation IN ($1, $2) ORDER BY id",
        [generation, candidate],
      ),
    ).toEqual([
      { id: "osm:node/1", srid: 3857 },
      { id: "osm:node/2", srid: 3857 },
    ]);
    expect(
      await superuser.unsafe(
        "SELECT to_regclass($1) IS NULL AS renamed, to_regclass($2) IS NOT NULL AS attached",
        [featureTable(candidate, "candidate"), featureTable(candidate)],
      ),
    ).toEqual([{ renamed: true, attached: true }]);
    await dataManager.begin((tx) => retireAmbientGenerations(tx));
    expect(await dropRetiredFeatureStorage(dataManager)).toBe(true);
    expect(
      await superuser.unsafe(
        "SELECT to_regclass($1) IS NULL AND to_regclass($2) IS NULL AS dropped",
        [featureTable(generation), featureTable(candidate)],
      ),
    ).toEqual([{ dropped: true }]);
    await dataManager.unsafe("DROP SCHEMA ambient_places CASCADE");
  });

  it("lets data-manager write tables but no code or view that the API could run", async () => {
    // The tables data-manager's ambient-places build creates.
    await dataManager.unsafe(`
      CREATE SCHEMA ambient_places;
      CREATE TABLE ambient_places.features (generation uuid NOT NULL, name text NOT NULL);
      INSERT INTO ambient_places.features VALUES ('00000000-0000-4000-8000-000000000001', 'kept');
    `);
    expect(await api.unsafe("SELECT name FROM ambient_places.features")).toEqual([
      { name: "kept" },
    ]);
    for (const statement of [
      "CREATE VIEW ambient_places.features_all AS SELECT name FROM ambient_places.features",
      // Refused before PostgreSQL looks for the view.
      "DROP VIEW IF EXISTS ambient_places.features_all",
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
    ])
      await permissionDenied(dataManager.unsafe(statement));
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
    await dataManager.unsafe(
      "INSERT INTO data_manager.configuration_fence SELECT * FROM data_manager.configuration_fence WHERE false",
    );
    await dataManager.unsafe(
      "UPDATE data_manager.configuration_fence SET state = state WHERE false",
    );
    await dataManager.unsafe("DELETE FROM data_manager.configuration_fence WHERE false");
    await api.unsafe("DELETE FROM data_manager.jobs WHERE false");
  });

  it("keeps a schema data-manager builds readable by the API across a swap", async () => {
    const build = async (schema: string, label: string) => {
      await dataManager.unsafe(`
        DROP SCHEMA IF EXISTS "${schema}" CASCADE;
        CREATE SCHEMA "${schema}";
        ${buildPublicationFenceDDL(schema)}
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
    // The publication locks the live fence, renames both schemas, drops the old fence and schema.
    await publishSchemaSwap(dataManager, {
      live: "osm_search",
      staging: "osm_search__staging",
      retry: { attempts: 2, backoffMs: 10 },
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
  /** The database container as the CLI's restore reaches it, with the last
   * dump as the archive; the restore below is the CLI's own code. */
  const container: services.RestoreContainer = {
    async run(command, stdin, catalogsOnly) {
      const env = catalogsOnly ? ["env", `PGOPTIONS=${services.SUPERUSER_PGOPTIONS}`] : [];
      let argv = [...env, ...command];
      if (stdin) {
        const preamble = "preamble" in stdin;
        await db.copyContentToContainer([
          { content: preamble ? stdin.preamble : stdin.input, target: "/tmp/restore-stdin" },
        ]);
        argv = [
          "sh",
          "-c",
          preamble
            ? 'cat /tmp/restore-stdin /tmp/openmapx.dump | "$@"'
            : '"$@" < /tmp/restore-stdin',
          "restore",
          ...argv,
        ];
      }
      const result = await db.exec(argv);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };
  /** Dumps the live database through a pipe and plans its restore, as the CLI does first. */
  const dumpAndPlan = async () => {
    await run(
      ["sh", "-c", "pg_dump --format=custom -U postgres openmapx | cat > /tmp/openmapx.dump"],
      "dump",
    );
    return services.planArchiveRestore(container, "postgres");
  };
  /** The CLI's restore of a planned dump into a scratch database swapped in on
   * success; resolves whether the replaced database had to be kept. */
  const restoreAsTheCli = (passes: services.RestorePass[]) =>
    services.restoreIntoScratchDatabase(container, {
      superuser: "postgres",
      db: "openmapx",
      load: (scratch) => services.restoreArchivePasses(container, passes, "postgres", scratch),
    });
  /** The live platform database still holds the API's accounts and no restore leftovers. */
  const liveDatabaseIntact = async () => {
    expect(
      await query(`SELECT string_agg(datname, ' ' ORDER BY datname) FROM pg_database
        WHERE datname LIKE 'openmapx%'`),
    ).toBe("openmapx\n");
    const accounts = await run(
      [
        ...superuserPsql,
        "-U",
        "postgres",
        "-d",
        "openmapx",
        "-At",
        "-c",
        `SELECT count(*) FROM public."user"`,
      ],
      "accounts",
    );
    expect(Number(accounts)).toBeGreaterThan(0);
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
    expect(await roles.api.unsafe("SHOW search_path")).toEqual([
      { search_path: "public, extensions" },
    ]);
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
    // A grant made by hand on the extensions schema does not survive a start.
    await roles.superuser.unsafe(`
      GRANT CREATE ON SCHEMA extensions TO openmapx_api WITH GRANT OPTION;
      SET ROLE openmapx_api;
      GRANT CREATE ON SCHEMA extensions TO openmapx_data_manager;
      RESET ROLE;
      REVOKE USAGE ON SCHEMA extensions FROM PUBLIC;
    `);
    await restart();
    expect(
      await roles.superuser`SELECT rolsuper FROM pg_roles WHERE rolname = 'openmapx_api'`,
    ).toEqual([{ rolsuper: false }]);
    expect(
      await roles.superuser`
        SELECT n.nspacl::text[] AS acl FROM pg_namespace n WHERE n.nspname = 'extensions'`,
    ).toEqual([{ acl: ["postgres=UC/postgres", "=U/postgres"] }]);
    await roles.api.unsafe("DROP FUNCTION public.format(text, name)");
  }, 120_000);

  it("refuses the API's extensions and other schemas", async () => {
    for (const statement of [
      // A trusted extension's script runs as the superuser in public.
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

  it("lets check constraints, domains and generated columns run only as the table's owner", async () => {
    // Accepted, with a row each, for the restore below to load: each runs as
    // its table's owner, whose session loads the row. Run as the superuser,
    // the function would fail the restore: it may not change a role.
    await roles.api.unsafe(`
      CREATE FUNCTION public.openmapx_escalate() RETURNS int LANGUAGE plpgsql IMMUTABLE AS $$
      BEGIN
        IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
          EXECUTE 'ALTER ROLE openmapx_api SUPERUSER';
        END IF;
        RETURN 1;
      END $$;
      CREATE DOMAIN public.openmapx_checked_value AS int CHECK (public.openmapx_escalate() = VALUE);
      CREATE TABLE public.openmapx_checked (
        v public.openmapx_checked_value CHECK (public.openmapx_escalate() = 1),
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

  it("lets no role but the superuser create a large object", async () => {
    // A large object is no schema object, so the role guard does not see it,
    // and a restore refuses one owned by the tile owner, who cannot log in.
    const creations = [
      "SELECT pg_catalog.lo_create(0)",
      "SELECT pg_catalog.lo_creat(-1)",
      "SELECT pg_catalog.lo_from_bytea(0, 'x')",
      "SELECT pg_catalog.lo_import('/etc/hostname')",
    ];
    for (const statement of creations) {
      await permissionDenied(roles.api.unsafe(statement));
      await permissionDenied(roles.dataManager.unsafe(statement));
      await permissionDenied(
        roles.superuser.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE openmapx_tiles_owner");
          await tx.unsafe(statement);
        }),
      );
    }
    expect(
      await roles.superuser`SELECT count(*)::int AS large_objects FROM pg_largeobject_metadata`,
    ).toEqual([{ large_objects: 0 }]);
  });

  /** A traffic tile as Martin requests it. */
  const tile = async () => {
    const martin = connect("openmapx_tiles", passwords.tiles, db);
    try {
      const [row] = await martin<{ tile: Buffer }[]>`
        SELECT tiles.segment_flow(0, 0, 0, '{}') AS tile`;
      return row?.tile;
    } finally {
      await martin.end();
    }
  };
  /** The same tile rendered by the superuser, with no grant involved. */
  const directTile = async () => {
    const [direct] = await roles.superuser.begin(async (tx) => {
      await tx.unsafe("SET LOCAL search_path = pg_catalog, extensions");
      return tx<{ tile: Buffer }[]>`SELECT conditions.segment_flow(0, 0, 0, '{}') AS tile`;
    });
    expect(direct?.tile.includes("speed_ratio")).toBe(true);
    return direct?.tile;
  };

  it("an OpenConditions schema created after PostGIS started serves tiles without a restart", async () => {
    // OpenConditions installed after PostGIS started, as its own role with
    // the documented search path, with its real tile function, the functions
    // and tables it reads, a table holding credentials, and the grants its
    // ingest service gives the tile function's role after migrating.
    await roles.superuser.unsafe(`
      CREATE ROLE openconditions_fixture LOGIN PASSWORD '${passwords.openConditions}';
      ALTER ROLE openconditions_fixture SET search_path = conditions, extensions;
      GRANT CREATE ON DATABASE openmapx TO openconditions_fixture;
    `);
    const openConditions = connect("openconditions_fixture", passwords.openConditions, db);
    try {
      await openConditions.unsafe("CREATE SCHEMA conditions");
      await openConditions.unsafe(readFileSync(TRAFFIC_FLOW, "utf8"));
      await openConditions.unsafe(`
        INSERT INTO conditions.road_segment
          (segment_id, way_id, dir, geom, highway, length_m, min_zoom, computed_at)
        VALUES ('s1', 1, 'f', ST_SetSRID(ST_MakeLine(ST_MakePoint(-1, -1), ST_MakePoint(1, 1)), 4326),
          'primary', 300, 0, now());
        INSERT INTO conditions.source
          (id, domain, format, product, access_mode, tier, operator, license, attribution,
           cadence_sec, freshness_window_sec)
        VALUES ('open', 'traffic', 'json', 'flow', 'bulk', 'authoritative', 'Fixture', 'ODbL-1.0',
          'Fixture', 60, 600);
        INSERT INTO conditions.segment_speed
          (segment_id, current_kph, free_flow_kph, speed_ratio, los, confidence, contributing,
           permission_licenses, updated_at)
        VALUES ('s1', 30, 50, 0.6, 'heavy', 'measured', ARRAY['open'], ARRAY['ODbL-1.0'], now());
        INSERT INTO conditions.public_license_policy VALUES ('ODbL-1.0');
        CREATE TABLE conditions.oauth_grant (
          source_id text PRIMARY KEY, refresh_token text NOT NULL, access_token text,
          access_token_expires_at timestamptz);
        INSERT INTO conditions.oauth_grant VALUES ('open', 'refresh-secret', 'access-secret', now());
      `);
      await openConditions`SELECT conditions.grant_consumer_roles()`;
    } finally {
      await openConditions.end();
    }
    expect(await tile()).toEqual(await directTile());
  });

  it("the tile owner cannot read a conditions table outside the contract", async () => {
    // A PostGIS start grants nothing in conditions, and the tile still renders.
    await restart();
    expect(await tile()).toEqual(await directTile());
    expect(
      await roles.superuser`
        SELECT has_table_privilege('openmapx_tiles_owner', 'conditions.oauth_grant', 'SELECT') AS secret,
          (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c
            WHERE c.relnamespace = 'conditions'::regnamespace AND c.relkind = 'r'
              AND has_table_privilege('openmapx_tiles_owner', c.oid, 'SELECT')) AS readable`,
    ).toEqual([{ secret: false, readable: TILE_CONTRACT_TABLES }]);
    await permissionDenied(
      roles.superuser.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE openmapx_tiles_owner");
        await tx.unsafe("SELECT refresh_token FROM conditions.oauth_grant");
      }),
    );
  }, 120_000);

  it("renders OpenConditions' traffic tile as a read-only role without superuser rights", async () => {
    const direct = await directTile();
    expect(await tile()).toEqual(direct);
    expect(
      await roles.superuser`
        SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, r.rolsuper AS superuser,
          has_table_privilege('openmapx_tiles_owner', 'conditions.segment_speed', 'INSERT') AS writes
        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid = 'tiles.segment_flow(integer, integer, integer, json)'::regprocedure`,
    ).toEqual([{ owner: "openmapx_tiles_owner", definer: true, superuser: false, writes: false }]);
    // The API can put PostGIS overloads in the public schema it owns, each a
    // closer match than PostGIS's own for the calls below. No other role
    // searches public, so none of them runs.
    await roles.api.unsafe(`
      CREATE TABLE public.openmapx_overload_runs (who text);
      GRANT INSERT ON public.openmapx_overload_runs TO PUBLIC;
      CREATE FUNCTION public.st_asmvt(r record, name text, extent integer, geom text) RETURNS bytea
        LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO public.openmapx_overload_runs VALUES (current_user);
          RETURN ''::bytea;
        END $$;
      CREATE FUNCTION public.st_makepoint(integer, integer) RETURNS extensions.geometry
        LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO public.openmapx_overload_runs VALUES (current_user);
          RETURN extensions.st_makepoint($1::double precision, $2::double precision);
        END $$;
    `);
    expect(
      await roles.api`SELECT extensions.st_astext(public.st_makepoint(1, 2)) AS point`,
    ).toEqual([{ point: "POINT(1 2)" }]);
    await roles.api`DELETE FROM public.openmapx_overload_runs`;
    expect(await tile()).toEqual(direct);
    const point = "SELECT ST_AsText(ST_MakePoint(1, 2)) AS point";
    expect(await roles.dataManager.unsafe(point)).toEqual([{ point: "POINT(1 2)" }]);
    const reader = connect("openconditions_fixture", passwords.openConditions, db);
    const martin = connect("openmapx_tiles", passwords.tiles, db);
    try {
      for (const table of ["conditions.road_segment", "conditions.source", 'public."user"'])
        await permissionDenied(martin.unsafe(`SELECT 1 FROM ${table} LIMIT 1`));
      expect(await reader.unsafe(point)).toEqual([{ point: "POINT(1 2)" }]);
      expect(await martin.unsafe(point)).toEqual([{ point: "POINT(1 2)" }]);
      // Martin asks for the PostGIS version when it opens its pool.
      const [version] = await martin.unsafe("SELECT postgis_lib_version() AS version");
      expect(version?.version).toMatch(/^3\./);
      expect(await martin.unsafe("SHOW search_path")).toEqual([{ search_path: "extensions" }]);
    } finally {
      await Promise.allSettled([reader.end(), martin.end()]);
    }
    expect(await roles.api`SELECT who FROM public.openmapx_overload_runs`).toEqual([]);
    // The tile owner may create nothing, even where it is granted the right:
    // a restore would recreate the object, and the tile owner cannot log in
    // to do it.
    await roles.api.unsafe("GRANT USAGE, CREATE ON SCHEMA public TO openmapx_tiles_owner");
    await permissionDenied(
      roles.superuser.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE openmapx_tiles_owner");
        await tx.unsafe("CREATE TABLE public.tiles_owner_t (id int)");
      }),
    );
    await roles.api.unsafe(`
      REVOKE CREATE ON SCHEMA public FROM openmapx_tiles_owner;
      DROP FUNCTION public.st_asmvt(record, text, integer, text);
      DROP FUNCTION public.st_makepoint(integer, integer);
      DROP TABLE public.openmapx_overload_runs;
    `);
  }, 180_000);

  it("keeps the live database when a role's settings or grants could break a restore", async () => {
    await roles.api.unsafe(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('kept-live', 'Kept', 'kept-live@example.test', true, now(), now())`,
    );
    // A grant chain through OpenConditions' role makes the dump restore the
    // grant as that role, which the API's restore session cannot become.
    await roles.api.unsafe(`
      CREATE TABLE public.openmapx_granted (id int);
      GRANT SELECT ON public.openmapx_granted TO openconditions_fixture WITH GRANT OPTION;
    `);
    const openConditions = connect("openconditions_fixture", passwords.openConditions, db);
    try {
      await openConditions.unsafe(
        "GRANT SELECT ON public.openmapx_granted TO openmapx_data_manager",
      );
    } finally {
      await openConditions.end();
    }
    await close();
    await expect(restoreAsTheCli(await dumpAndPlan())).rejects.toThrow(
      "permission denied to set session authorization",
    );
    await liveDatabaseIntact();
    open();
    await roles.api.unsafe("DROP TABLE public.openmapx_granted");
    // Data-manager makes its own sessions read-only: its restore pass fails,
    // and the live database stays as it was.
    await roles.dataManager.unsafe(
      "ALTER ROLE openmapx_data_manager SET default_transaction_read_only = on",
    );
    await close();
    await expect(restoreAsTheCli(await dumpAndPlan())).rejects.toThrow("read-only transaction");
    await liveDatabaseIntact();
    // PostGIS resets each role's own settings when it starts, and the restore
    // then succeeds.
    await restart();
    expect(await roles.dataManager.unsafe("SHOW default_transaction_read_only")).toEqual([
      { default_transaction_read_only: "off" },
    ]);
    await close();
    await expect(restoreAsTheCli(await dumpAndPlan())).resolves.toBe(false);
    await liveDatabaseIntact();
    open();
  }, 240_000);

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
        SELECT 'POINT(0 0)'::extensions.geometry AS g, public.openmapx_pwn() AS x;
      CREATE TABLE public.harmless (id int, CHECK (pg_catalog.length(COALESCE(
        extensions.st_findextent('data_manager', 'pwnv', 'g')::text, '')) >= 0));
      INSERT INTO public.harmless VALUES (1);
    `);
    // A PostGIS column and a PostGIS expression index of each role, which its
    // own restore session builds from the superuser's extensions schema.
    await roles.api.unsafe(`
      CREATE TABLE public.openmapx_spatial (geom geometry(Point, 4326) NOT NULL);
      CREATE INDEX openmapx_spatial_mercator_idx ON public.openmapx_spatial
        USING gist (ST_Transform(geom, 3857));
      INSERT INTO public.openmapx_spatial VALUES (ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326));
    `);
    await roles.dataManager.unsafe(`
      CREATE TABLE osm_search.points (geom geometry(Point, 4326) NOT NULL);
      CREATE INDEX points_geohash_idx ON osm_search.points (ST_GeoHash(geom, 6));
      INSERT INTO osm_search.points VALUES (ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326));
    `);
    await roles.dataManager.unsafe(`
      CREATE TABLE osm_search.planted (id int, CHECK (pg_catalog.length(COALESCE(extensions.st_findextent('osm_search', 't',
        'g") AS extent FROM (SELECT NULL::extensions.geometry AS g) s WHERE CASE WHEN (SELECT rolsuper FROM pg_catalog.pg_roles
         WHERE rolname = current_user) THEN pg_catalog.length(pg_catalog.query_to_xml(''SELECT pg_catalog.lo_from_bytea(4242, ''''pwn'''')'', true, false, '''')::text) ELSE 0 END >= 0 --')::text, '')) >= 0));
      INSERT INTO osm_search.planted VALUES (1);
    `);
    await close();
    // A role that cannot log in has nobody but the superuser to restore its
    // objects, so an archive holding one is refused before anything is
    // dropped.
    await query(
      "CREATE ROLE openmapx_nologin_owner NOLOGIN; GRANT CREATE ON DATABASE openmapx TO openmapx_nologin_owner",
    );
    await run(
      [
        ...superuserPsql,
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "openmapx",
        "-c",
        "CREATE SCHEMA nologin_owned AUTHORIZATION openmapx_nologin_owner; CREATE TABLE nologin_owned.t (id int); ALTER TABLE nologin_owned.t OWNER TO openmapx_nologin_owner",
      ],
      "plant an object of a role that cannot log in",
    );
    await expect(dumpAndPlan()).rejects.toThrow(
      "openmapx_nologin_owner, a role that cannot log in",
    );
    await run(
      [
        ...superuserPsql,
        "-U",
        "postgres",
        "-d",
        "openmapx",
        "-c",
        "DROP SCHEMA nologin_owned CASCADE",
      ],
      "drop it",
    );
    await query(
      "REVOKE CREATE ON DATABASE openmapx FROM openmapx_nologin_owner; DROP ROLE openmapx_nologin_owner",
    );
    // The CLI's restore: dump through a pipe and plan it against the server's
    // roles, read the live database's owner and grants, recreate the
    // database, give them back, then restore each entry in a session of its
    // owner.
    const passes = await dumpAndPlan();
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
      "post-data openconditions_fixture",
      "post-data openmapx_api",
      "post-data openmapx_data_manager",
      "post-data superuser",
      "pre-data openconditions_fixture",
      "pre-data openmapx_api",
      "pre-data openmapx_data_manager",
      "pre-data superuser",
    ]);
    expect(passes.at(-1)).toMatchObject({ role: null, section: "post-data" });
    await expect(restoreAsTheCli(passes)).resolves.toBe(false);
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
          has_table_privilege('openmapx_tiles_owner', 'conditions.road_segment', 'SELECT') AS tile_read,
          has_table_privilege('openmapx_tiles_owner', 'conditions.oauth_grant', 'SELECT') AS secret_read
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
        secret_read: false,
      },
    ]);
    expect(await roles.api.unsafe("SELECT name FROM osm_search.places")).toEqual([
      { name: "kept" },
    ]);
    expect(
      await roles.superuser`
        SELECT c.relname AS index, pg_get_userbyid(c.relowner) AS owner, i.indisvalid AS valid,
          (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
            WHERE e.extname = 'postgis') AS postgis,
          has_schema_privilege('openmapx_tiles', 'extensions', 'USAGE') AS usable
        FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname IN ('openmapx_spatial_mercator_idx', 'points_geohash_idx')
        ORDER BY 1`,
    ).toEqual([
      {
        index: "openmapx_spatial_mercator_idx",
        owner: "openmapx_api",
        valid: true,
        postgis: "extensions",
        usable: true,
      },
      {
        index: "points_geohash_idx",
        owner: "openmapx_data_manager",
        valid: true,
        postgis: "extensions",
        usable: true,
      },
    ]);
    expect(
      await roles.api.unsafe(`
        SELECT (SELECT ST_AsText(geom) FROM public.openmapx_spatial) AS api,
          (SELECT ST_AsText(geom) FROM osm_search.points) AS data_manager`),
    ).toEqual([{ api: "POINT(13.4 52.5)", data_manager: "POINT(13.4 52.5)" }]);
    await permissionDenied(roles.dataManager.unsafe(`SELECT 1 FROM public."user"`));
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
