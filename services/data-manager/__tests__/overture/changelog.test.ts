import { describe, expect, it } from "vitest";
import {
  buildDeleteSql,
  buildInsertSql,
  buildUpdateSql,
} from "../../src/jobs/overture/changelog.js";

describe("changelog delta SQL builders", () => {
  it("buildInsertSql contains INSERT and gers_id and added change_type", () => {
    const sql = buildInsertSql("overture_places");
    expect(sql).toContain("INSERT INTO");
    expect(sql).toContain('"overture_places".places');
    expect(sql).toContain("gers_id");
    expect(sql).toContain("added");
    expect(sql).toContain("ON CONFLICT");
  });

  it("buildUpdateSql contains UPDATE and gers_id and data_changed", () => {
    const sql = buildUpdateSql("overture_places");
    expect(sql).toContain("UPDATE");
    expect(sql).toContain('"overture_places".places');
    expect(sql).toContain("gers_id");
    expect(sql).toContain("data_changed");
  });

  it("buildDeleteSql contains DELETE and gers_id and removed", () => {
    const sql = buildDeleteSql("overture_places");
    expect(sql).toContain("DELETE FROM");
    expect(sql).toContain('"overture_places".places');
    expect(sql).toContain("gers_id");
    expect(sql).toContain("removed");
  });

  it("all builders use the provided schema name", () => {
    expect(buildInsertSql("my_schema")).toContain('"my_schema".places');
    expect(buildUpdateSql("my_schema")).toContain('"my_schema".places');
    expect(buildDeleteSql("my_schema")).toContain('"my_schema".places');
  });
});
