import { describe, expect, it } from "vitest";
import { attentionUpsertStatement } from "./attention-sql";

describe("attentionUpsertStatement", () => {
  it("passes absent fields as null and the default clearance", () => {
    const { text, values } = attentionUpsertStatement({
      key: "k",
      severity: "info",
      source: "test",
      title: "T",
    });
    expect(values).toEqual(["k", "info", "test", "T", null, null, "condition", null]);
    expect(text).toContain("ON CONFLICT (key) DO UPDATE");
    expect(text).toContain("AS outcome");
  });

  it("passes the action as JSON and the occurrence reference", () => {
    const { values } = attentionUpsertStatement({
      key: "k",
      severity: "warning",
      source: "operations",
      title: "T",
      detail: "D",
      action: { label: "Open", href: "/admin" },
      clearance: "acknowledge",
      occurrenceRef: "job-1",
    });
    expect(values).toEqual([
      "k",
      "warning",
      "operations",
      "T",
      "D",
      '{"label":"Open","href":"/admin"}',
      "acknowledge",
      "job-1",
    ]);
  });
});
