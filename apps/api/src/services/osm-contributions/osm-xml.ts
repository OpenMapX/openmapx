/**
 * Deterministic XML for the two OSM mutations this feature performs.
 *
 * OSM's element-update endpoint requires a *complete* representation, so a
 * missing `<nd>` or `<member>` silently destroys geometry. The builder types
 * therefore require those properties, and everything goes through
 * `fast-xml-parser`'s builder — hand-concatenated XML would make escaping a
 * per-call decision.
 */
import { XMLBuilder } from "fast-xml-parser";
import type { OsmWritableElement } from "./types.js";

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  suppressEmptyNode: true,
  // Without this the builder collapses `visible="true"` to a bare `visible`,
  // which OSM does not accept as a boolean attribute value.
  suppressBooleanAttributes: false,
  // Deterministic single-line output: no indentation to differ across versions.
  format: false,
  processEntities: true,
});

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** Tags are emitted in sorted key order so identical input yields identical XML. */
function tagNodes(tags: Readonly<Record<string, string>>): Array<Record<string, string>> {
  return Object.keys(tags)
    .sort()
    .map((key) => ({ "@k": key, "@v": tags[key] as string }));
}

function wrap(root: Record<string, unknown>): string {
  return `${XML_DECLARATION}${builder.build({
    osm: { "@version": "0.6", "@generator": "OpenMapX", ...root },
  })}`;
}

/**
 * A complete element ready for `PUT /api/0.6/{type}/{id}`.
 *
 * Only the attributes OSM accepts on a write are emitted: read-only server
 * metadata (`user`, `uid`, `timestamp`) is deliberately dropped.
 */
export function buildElementXml(element: OsmWritableElement): string {
  const common: Record<string, unknown> = {
    "@id": String(element.id),
    "@version": String(element.version),
    "@changeset": String(element.changeset),
  };

  if (element.type === "node") {
    return wrap({
      node: {
        ...common,
        "@lat": String(element.lat),
        "@lon": String(element.lon),
        ...(element.visible === undefined ? {} : { "@visible": String(element.visible) }),
        ...(Object.keys(element.tags).length > 0 ? { tag: tagNodes(element.tags) } : {}),
      },
    });
  }

  if (element.type === "way") {
    return wrap({
      way: {
        ...common,
        ...(element.visible === undefined ? {} : { "@visible": String(element.visible) }),
        nd: element.nodes.map((ref) => ({ "@ref": String(ref) })),
        ...(Object.keys(element.tags).length > 0 ? { tag: tagNodes(element.tags) } : {}),
      },
    });
  }

  return wrap({
    relation: {
      ...common,
      ...(element.visible === undefined ? {} : { "@visible": String(element.visible) }),
      member: element.members.map((member) => ({
        "@type": member.type,
        "@ref": String(member.ref),
        "@role": member.role,
      })),
      ...(Object.keys(element.tags).length > 0 ? { tag: tagNodes(element.tags) } : {}),
    },
  });
}

/** The changeset body for `PUT /api/0.6/changeset/create`. */
export function buildChangesetXml(tags: Readonly<Record<string, string>>): string {
  return wrap({
    changeset: Object.keys(tags).length > 0 ? { tag: tagNodes(tags) } : {},
  });
}
