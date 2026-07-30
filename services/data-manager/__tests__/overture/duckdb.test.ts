import { describe, expect, it } from "vitest";
import {
  duckDbScriptProcessOptions,
  duckDbSqlLiteral,
  redactConnectionString,
} from "../../src/jobs/overture/duckdb.js";

describe("redactConnectionString", () => {
  it("redacts the password in a postgresql:// connection string", () => {
    const out = redactConnectionString(
      "ATTACH 'postgresql://postgres:s3cr3t_pw@postgis:5432/openmapx' AS pg",
    );
    expect(out).toBe("ATTACH 'postgresql://postgres:***@postgis:5432/openmapx' AS pg");
    expect(out).not.toContain("s3cr3t_pw");
  });

  it("redacts the postgres:// scheme too and a long hex password", () => {
    const pw = "cf077282f9e9e760962f521814513864";
    const out = redactConnectionString(
      `Command failed: duckdb -c "ATTACH 'postgres://user:${pw}@host:5432/db'"`,
    );
    expect(out).not.toContain(pw);
    expect(out).toContain("postgres://user:***@host:5432/db");
  });

  it("redacts every occurrence", () => {
    const out = redactConnectionString("postgresql://a:p1@h1/d postgresql://b:p2@h2/d");
    expect(out).not.toMatch(/p1|p2/);
  });

  it("leaves text without a connection string unchanged", () => {
    expect(redactConnectionString("Binder Error: column not found")).toBe(
      "Binder Error: column not found",
    );
  });

  it("leaves a connection string without a password unchanged", () => {
    expect(redactConnectionString("postgres://postgis:5432/openmapx")).toBe(
      "postgres://postgis:5432/openmapx",
    );
  });
});

describe("duckDbSqlLiteral", () => {
  it("escapes credentials and paths containing apostrophes", () => {
    expect(duckDbSqlLiteral("postgres://user:p'ass@db/openmapx")).toBe(
      "'postgres://user:p''ass@db/openmapx'",
    );
  });
});

describe("DuckDB secret transport", () => {
  it("sends SQL via stdin and removes DATABASE_URL from the inherited child environment", () => {
    const options = duckDbScriptProcessOptions("ATTACH 'secret' AS pg", {
      PATH: "/bin",
      DATABASE_URL: "postgresql://user:secret@db/openmapx",
    });
    expect(options.input).toBe("ATTACH 'secret' AS pg");
    expect(options.extendEnv).toBe(false);
    expect(options.env).toEqual({ PATH: "/bin" });
  });
});
