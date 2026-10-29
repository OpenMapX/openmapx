import { describe, expect, it } from "vitest";
import { dedupeAttributionHtml, projectMapAttributions } from "./mapAttributionStore";

describe("dedupeAttributionHtml", () => {
  it("collapses a credit contributed by several layers", () => {
    const osm = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    expect(dedupeAttributionHtml([osm, "© MapTiler", osm])).toEqual([osm, "© MapTiler"]);
  });

  it("keeps longer wording around a complete credited publisher fragment", () => {
    expect(dedupeAttributionHtml(["© OSM contributors", "Map data © OSM contributors"])).toEqual([
      "Map data © OSM contributors",
    ]);
  });

  it("drops empty entries and preserves registration order otherwise", () => {
    expect(dedupeAttributionHtml(["© A", "", "© B"])).toEqual(["© A", "© B"]);
  });

  it("keeps the linked basemap credit when flow repeats its wording and licence", () => {
    const license = '<a href="https://opendatacommons.org/licenses/odbl/1.0/">ODbL-1.0</a>';
    const base = `© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> (${license})`;
    const flow = `© OpenStreetMap contributors (${license})`;
    expect(dedupeAttributionHtml([base, flow])).toEqual([base]);
    expect(dedupeAttributionHtml([flow, base])).toEqual([base]);
  });

  it("preserves equal wording with distinct licence targets", () => {
    const first = '© OSM (<a href="https://example.org/first">Licence</a>)';
    const second = '© OSM (<a href="https://example.org/second">Licence</a>)';
    expect(dedupeAttributionHtml([first, second])).toEqual([first, second]);
  });

  it("preserves complementary publisher and licence links", () => {
    const publisher = '© <a href="https://example.org/provider">Provider</a> (Licence)';
    const license = '© Provider (<a href="https://example.org/license">Licence</a>)';
    expect(dedupeAttributionHtml([publisher, license])).toEqual([publisher, license]);
  });

  it("keeps the first copy when only anchor attributes differ", () => {
    const first = '© <a href="https://example.org">Provider</a>';
    const second = '© <a href="https://example.org" target="_blank">Provider</a>';
    expect(dedupeAttributionHtml([first, second])).toEqual([first]);
  });

  it("retains a notice when equivalent copies differ by trailing whitespace", () => {
    expect(dedupeAttributionHtml(["© OSM", "© OSM "])).toEqual(["© OSM"]);
    expect(dedupeAttributionHtml(["© OSM ", "© OSM"])).toEqual(["© OSM "]);
  });
});

it("unions permanent and complete credits independently so an eligible copy cannot hide a required copy", () => {
  const fullHtml = '<a href="https://provider.test/">Provider</a>';
  const details = { fullHtml, visibleHtml: "", logos: [] };
  const required = { fullHtml, visibleHtml: fullHtml, logos: [] };
  expect(projectMapAttributions([details, required])).toMatchObject({
    fullHtml: [fullHtml],
    visible: [{ html: fullHtml }],
  });
  expect(projectMapAttributions([required, details])).toMatchObject({
    fullHtml: [fullHtml],
    visible: [{ html: fullHtml }],
  });
});

it("merges a compact publisher link into a fuller visible notice without losing either licence link", () => {
  const publisher =
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
  const full =
    '© OpenStreetMap contributors (<a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL-1.0</a>)';
  const result = projectMapAttributions([
    { fullHtml: full, visibleHtml: publisher, logos: [] },
    { fullHtml: full, visibleHtml: full, logos: [] },
  ]);
  expect(result.visible).toHaveLength(1);
  expect(result.visible[0].html).toContain('href="https://www.openstreetmap.org/copyright"');
  expect(result.visible[0].html).toContain('href="https://opendatacommons.org/licenses/odbl/1-0/"');
  expect(result.visible[0].html.match(/OpenStreetMap contributors/g)).toHaveLength(1);
});
