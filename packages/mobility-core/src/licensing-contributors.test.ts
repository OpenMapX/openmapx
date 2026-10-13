import { describe, expect, it } from "vitest";
import {
  dataSourceToAttribution,
  parseContributors,
  parseFieldContributors,
  snapshotContributors,
  withFeatureContributors,
} from "./contributors.js";

const licensing = {
  version: 1 as const,
  bindings: [
    {
      scope: "data" as const,
      subject: "Road dataset",
      license: {
        kind: "custom" as const,
        namespace: "publisher:one",
        id: "LicenseRef-Data",
        name: "Captured terms",
        url: "https://example.test/terms/v1",
      },
      notice: "Required original notice",
      conditions: ["Preserve revision date"],
    },
  ],
};
const receipt = { sourceId: "source-one", name: "Publisher", licensing };

describe("structured licensing through contribution boundaries", () => {
  it("captures deep metadata and keeps definitions immutable after input changes", () => {
    const input = structuredClone(receipt);
    const [captured] = parseContributors([input])!;
    input.licensing.bindings[0].license.name = "Changed after acquisition";
    input.licensing.bindings[0].conditions.push("Later term");
    expect(captured).toMatchObject(receipt);
    expect(captured.licensing).not.toBe(input.licensing);
  });

  it("does not union distinct definitions, scopes, notices or namespaces sharing a licence reference", () => {
    const other = structuredClone(receipt);
    other.licensing.bindings[0].license.namespace = "publisher:two";
    expect(snapshotContributors([receipt, other])).toHaveLength(2);
    const changedNotice = structuredClone(receipt);
    changedNotice.licensing.bindings[0].notice = "Another required notice";
    expect(snapshotContributors([receipt, changedNotice])).toHaveLength(2);
  });

  it("rejects a malformed new descriptor as part of the whole receipt", () => {
    expect(
      parseContributors([{ ...receipt, licensing: { version: 2, bindings: [] } }]),
    ).toBeUndefined();
    expect(
      parseFieldContributors({ road: [{ ...receipt, licensing: { version: 2, bindings: [] } }] }),
    ).toBeUndefined();
  });

  it("roundtrips complete metadata in rendered feature and field receipts", () => {
    const feature = withFeatureContributors({ properties: {} }, [receipt]);
    expect(parseContributors(feature.properties._mapAttributions)).toEqual([receipt]);
    expect(parseFieldContributors({ speed: [receipt] })?.speed).toEqual([receipt]);
  });

  it("preserves structured identity without emitting a scalar display compatibility field", () => {
    const source = {
      sourceId: "source-one",
      name: "Publisher",
      url: "https://example.test",
      licensing,
    };
    expect(dataSourceToAttribution(source).licensing).toEqual(licensing);
    expect(dataSourceToAttribution(source)).not.toHaveProperty("spdxLicense");
  });
});

it("preserves special field keys as own data without changing the field-map prototype", () => {
  const fields = parseFieldContributors(JSON.parse(JSON.stringify({ ["__proto__"]: [receipt] })))!;
  expect(Object.hasOwn(fields, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
});

it("never replaces a present malformed receipt with envelope attribution", async () => {
  const { captureResultContributors } = await import("./contributors.js");
  const malformed = { ...receipt, licensing: { version: 2, bindings: [] } };
  expect(
    captureResultContributors({ contributors: [malformed] as unknown as (typeof receipt)[] }, [
      receipt,
    ]),
  ).toEqual([]);
  expect(captureResultContributors({}, [receipt])).toEqual([receipt]);
});
