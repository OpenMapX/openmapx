import { describe, expect, it } from "vitest";
import {
  databaseSettingsQuery,
  databaseSwapSql,
  planOwnerRestore,
  restoreDatabaseNames,
  restorePassCommand,
  restorePassPreamble,
  swapPreconditionRefusal,
  swapPreconditionsQuery,
} from "../database-roles";

const roles = [
  "1 1 postgres",
  "0 1 openmapx_api",
  "0 1 openmapx_data_manager",
  "0 0 openmapx_tiles_owner",
].join("\n");

const listings = {
  preData: [
    ";",
    "; Archive created at 2026-11-13 12:00:00 UTC",
    ";",
    "16; 2615 21089 SCHEMA - data_manager openmapx_api",
    "5964; 0 0 ACL - SCHEMA data_manager openmapx_api",
    "5; 3079 18937 EXTENSION - postgis ",
    "321; 1259 21090 TABLE data_manager jobs openmapx_api",
    "323; 1259 21118 TABLE data_manager job stages openmapx_api",
    "361; 1259 22460 TABLE osm_search places openmapx_data_manager",
    "442; 1255 18300 FUNCTION tiles segment_flow(integer, integer, integer, json) openmapx_tiles_owner",
    "",
  ].join("\n"),
  data: [
    "5950; 0 21090 TABLE DATA data_manager jobs openmapx_api",
    "5953; 0 22460 TABLE DATA osm_search places openmapx_data_manager",
    "5951; 0 0 TABLE DATA public spatial_ref_sys postgres",
    "5952; 0 21119 SEQUENCE SET data_manager jobs_id_seq openmapx_api",
  ].join("\n"),
  postData: [
    "5673; 1259 22466 INDEX osm_search places_lower_idx openmapx_data_manager",
    "5600; 2606 21120 CONSTRAINT data_manager jobs jobs_pkey openmapx_api",
    "5999; 3466 18301 EVENT TRIGGER - openmapx_guard_check_ddl postgres",
  ].join("\n"),
};

describe("planOwnerRestore", () => {
  it("restores each entry as its owner, in archive order, with the superuser's triggers last", () => {
    expect(planOwnerRestore(listings, roles)).toEqual([
      // Schemas and extensions run no code; a role that cannot log in gets
      // objects only from the superuser.
      { role: null, section: "pre-data", entries: [16] },
      { role: "openmapx_api", section: "pre-data", entries: [5964] },
      { role: null, section: "pre-data", entries: [5] },
      { role: "openmapx_api", section: "pre-data", entries: [321, 323] },
      { role: "openmapx_data_manager", section: "pre-data", entries: [361] },
      { role: null, section: "pre-data", entries: [442] },
      { role: "openmapx_api", section: "data", entries: [5950, 5952] },
      { role: "openmapx_data_manager", section: "data", entries: [5953] },
      { role: null, section: "data", entries: [5951] },
      { role: "openmapx_data_manager", section: "post-data", entries: [5673] },
      { role: "openmapx_api", section: "post-data", entries: [5600] },
      { role: null, section: "post-data", entries: [5999] },
    ]);
  });

  it("refuses entries of a role that cannot log in, except PostGIS's tile function", () => {
    for (const entry of [
      "500; 1259 30000 TABLE public tiles_owner_t openmapx_tiles_owner",
      "501; 1255 30001 FUNCTION tiles segment_flow(integer, integer, integer) openmapx_tiles_owner",
      "502; 2613 30002 BLOB METADATA - 4242 openmapx_tiles_owner",
    ])
      expect(() =>
        planOwnerRestore({ ...listings, preData: `${listings.preData}${entry}\n` }, roles),
      ).toThrow("a role that cannot log in to restore it");
  });

  it("refuses a role's code that would exist before an extension's script runs", () => {
    const aheadOfPostgis = (entry: string) =>
      listings.preData.replace(
        "5; 3079 18937 EXTENSION - postgis ",
        `${entry}\n5; 3079 18937 EXTENSION - postgis `,
      );
    expect(() =>
      planOwnerRestore(
        {
          ...listings,
          preData: aheadOfPostgis("400; 1255 40000 FUNCTION public st_x(text) openmapx_api"),
        },
        roles,
      ),
    ).toThrow("before an extension");
    expect(
      planOwnerRestore(
        {
          ...listings,
          preData: aheadOfPostgis("401; 3456 40001 COLLATION public probe openmapx_api"),
        },
        roles,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("refuses entries of a role the server lacks and lines it cannot read", () => {
    expect(() =>
      planOwnerRestore(
        { ...listings, data: "5950; 0 21090 TABLE DATA public t community_role" },
        roles,
      ),
    ).toThrow("community_role, a role this server lacks");
    expect(() => planOwnerRestore({ ...listings, postData: "garbage" }, roles)).toThrow(
      "Unreadable backup entry",
    );
  });

  it("hands pg_restore the entry list before the archive and logs in as the owner", () => {
    const pass = { role: "openmapx_api", section: "data", entries: [5950, 5952] } as const;
    expect(restorePassPreamble(pass)).toBe("5950;\n5952;\n\n");
    const command = restorePassCommand(pass, "postgres", "openmapx", 180001);
    // Pinned at login over whatever defaults the role set for its sessions.
    expect(command[1]).toBe(
      "PGOPTIONS=-c default_transaction_read_only=off -c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0 -c transaction_timeout=0",
    );
    expect(command.slice(6)).toEqual([
      "--single-transaction",
      "--exit-on-error",
      "-U",
      "openmapx_api",
      "-d",
      "openmapx",
    ]);
    expect(restorePassCommand({ ...pass, role: null }, "postgres", "openmapx", 180001)).toContain(
      "postgres",
    );
  });

  it("pins transaction_timeout only on a server that knows it", () => {
    const pass = { role: "openmapx_api", section: "data", entries: [1] } as const;
    const options = (version: number) =>
      restorePassCommand(pass, "postgres", "openmapx", version)[1];
    // PostgreSQL 16 refuses an unknown setting at login; 17 added this one.
    expect(options(160004)).toBe(
      "PGOPTIONS=-c default_transaction_read_only=off -c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0",
    );
    expect(options(169999)).not.toContain("transaction_timeout=0 ");
    expect(options(169999).endsWith("idle_in_transaction_session_timeout=0")).toBe(true);
    expect(options(170000)).toContain(" -c transaction_timeout=0");
  });
});

describe("restoring into a scratch database", () => {
  it("counts only sessions of services the restore leaves running", () => {
    const stopping = new Set(["app-api"]);
    expect(
      swapPreconditionRefusal("openmapx", "previous|0\nsession|openmapx_api\n", stopping),
    ).toBe(undefined);
    expect(
      swapPreconditionRefusal(
        "openmapx",
        "previous|0\nsession|openmapx_api\nsession|openmapx_data_manager\nsession|postgres\n",
        stopping,
      ),
    ).toBe(
      "database openmapx is in use by data-manager, role postgres, which would keep the restored database from replacing it; stop them, then restore again",
    );
    expect(swapPreconditionRefusal("openmapx", "previous|1\n", stopping)).toContain(
      "database openmapx__previous, left by an earlier restore, still exists",
    );
    expect(swapPreconditionsQuery("openmapx")).toContain("datname = 'openmapx__previous'");
    expect(() => swapPreconditionsQuery("bad'name")).toThrow("Unsafe database name");
  });

  it("names the scratch and replaced databases beside the live one", () => {
    expect(restoreDatabaseNames("openmapx")).toEqual({
      scratch: "openmapx__restore",
      previous: "openmapx__previous",
    });
    expect(() => restoreDatabaseNames("a".repeat(60))).toThrow("Unsafe database name");
    expect(() => restoreDatabaseNames("bad name")).toThrow("Unsafe database name");
  });

  it("copies the live database's settings to the scratch one and swaps both in one go", () => {
    const settings = databaseSettingsQuery("openmapx", "openmapx__restore");
    expect(settings).toContain("WHERE d.datname = 'openmapx'");
    expect(settings).toContain("'openmapx__restore'");
    expect(
      databaseSwapSql("openmapx"),
    ).toBe(`SELECT format('ALTER DATABASE %I RENAME TO %I', 'openmapx', 'openmapx__previous')
  WHERE EXISTS (SELECT FROM pg_database WHERE datname = 'openmapx')
\\gexec
SELECT format('ALTER DATABASE %I RENAME TO %I', 'openmapx__restore', 'openmapx')
\\gexec
`);
  });
});
