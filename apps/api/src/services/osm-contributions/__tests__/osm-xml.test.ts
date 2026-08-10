import { describe, expect, it } from "vitest";
import { buildChangesetXml, buildElementXml } from "../osm-xml.js";
import type { OsmWritableElement } from "../types.js";

const node: OsmWritableElement = {
  type: "node",
  id: 4_000_000_001,
  version: 7,
  changeset: 99,
  lat: 52.5162746,
  lon: 13.3777041,
  visible: true,
  tags: { name: "Café Central", amenity: "cafe", "name:de": "Café Central" },
};

const way: OsmWritableElement = {
  type: "way",
  id: 42,
  version: 3,
  changeset: 99,
  nodes: [1, 2, 3, 1],
  tags: { building: "yes" },
};

const relation: OsmWritableElement = {
  type: "relation",
  id: 62_422,
  version: 12,
  changeset: 99,
  members: [
    { type: "way", ref: 10, role: "outer" },
    { type: "way", ref: 11, role: "" },
    { type: "node", ref: 12, role: "label" },
    { type: "relation", ref: 13, role: "subarea" },
  ],
  tags: { type: "multipolygon", name: "Park" },
};

describe("buildElementXml", () => {
  it("serializes a node with exact coordinates, version and changeset", () => {
    expect(buildElementXml(node)).toMatchInlineSnapshot(
      `"<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="OpenMapX"><node id="4000000001" version="7" changeset="99" lat="52.5162746" lon="13.3777041" visible="true"><tag k="amenity" v="cafe"/><tag k="name" v="Café Central"/><tag k="name:de" v="Café Central"/></node></osm>"`,
    );
  });

  it("preserves every ordered way node reference", () => {
    const xml = buildElementXml(way);
    expect(xml).toMatchInlineSnapshot(
      `"<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="OpenMapX"><way id="42" version="3" changeset="99"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="1"/><tag k="building" v="yes"/></way></osm>"`,
    );
    expect([...xml.matchAll(/<nd ref="(\d+)"\/>/g)].map((m) => m[1])).toEqual(["1", "2", "3", "1"]);
  });

  it("preserves every ordered relation member, including an empty role", () => {
    expect(buildElementXml(relation)).toMatchInlineSnapshot(
      `"<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="OpenMapX"><relation id="62422" version="12" changeset="99"><member type="way" ref="10" role="outer"/><member type="way" ref="11" role=""/><member type="node" ref="12" role="label"/><member type="relation" ref="13" role="subarea"/><tag k="name" v="Park"/><tag k="type" v="multipolygon"/></relation></osm>"`,
    );
  });

  it("escapes hostile characters instead of interpreting them", () => {
    const xml = buildElementXml({
      ...node,
      tags: {
        name: `</tag><tag k="amenity" v="hacked"/>`,
        "note:<x>": `a & b "quoted" 'single'`,
      },
    });
    expect(xml).not.toContain(`v="hacked"`);
    expect(xml).toContain("&lt;/tag&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
    expect([...xml.matchAll(/<tag /g)]).toHaveLength(2);
  });

  it("preserves Unicode, including astral characters", () => {
    const xml = buildElementXml({ ...node, tags: { name: "Café 😀 Zürich" } });
    expect(xml).toContain(`v="Café 😀 Zürich"`);
  });

  it("orders tags deterministically regardless of insertion order", () => {
    const a = buildElementXml({ ...node, tags: { b: "2", a: "1", c: "3" } });
    const b = buildElementXml({ ...node, tags: { c: "3", a: "1", b: "2" } });
    expect(a).toBe(b);
  });

  it("omits the visible attribute when it is not known", () => {
    expect(buildElementXml(way)).not.toContain("visible=");
  });

  it("emits visible=false verbatim", () => {
    expect(buildElementXml({ ...node, visible: false })).toContain(`visible="false"`);
  });

  it("never sends read-only upstream metadata", () => {
    const xml = buildElementXml({
      ...node,
      ...({ user: "someone", uid: 5, timestamp: "2026-01-01T00:00:00Z" } as object),
    } as OsmWritableElement);
    for (const attribute of ["user=", "uid=", "timestamp="]) {
      expect(xml).not.toContain(attribute);
    }
  });

  it("serializes a tag-free element without an empty tag node", () => {
    expect(buildElementXml({ ...way, tags: {} })).not.toContain("<tag");
  });
});

describe("buildChangesetXml", () => {
  it("emits only policy-produced tags", () => {
    expect(
      buildChangesetXml({
        comment: "Corrected the name from the sign",
        created_by: "OpenMapX 1.0",
        locale: "en",
        source: "survey",
        review_requested: "yes",
      }),
    ).toMatchInlineSnapshot(
      `"<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="OpenMapX"><changeset><tag k="comment" v="Corrected the name from the sign"/><tag k="created_by" v="OpenMapX 1.0"/><tag k="locale" v="en"/><tag k="review_requested" v="yes"/><tag k="source" v="survey"/></changeset></osm>"`,
    );
  });

  it("escapes a hostile comment", () => {
    const xml = buildChangesetXml({ comment: `"><tag k="bot" v="yes"/>` });
    expect(xml).not.toContain(`k="bot"`);
    expect(xml).toContain("&quot;&gt;&lt;tag");
  });

  it("supports an empty tag set", () => {
    expect(buildChangesetXml({})).toContain("<changeset/>");
  });
});
