# Station-search regression captures

`station-search.json` contains minimal MapTiler response features captured on
2026-10-06 using a developer key, `language=en`, `limit=10`, and the adapter's
explicit `types` list (including `poi`). No API keys or request URLs are stored.
Feature order, IDs, names, matching aliases, relevance, coordinates, categories,
and settlement/administrative context are retained from the responses. Unused
properties and OSM tags are omitted.

The long/short and reversed Neuss queries intentionally have different candidate
orders. Neuss's actual railway station is `poi.14564580`; `poi.27957867` is a bus
platform, and `poi.32849890` is a signal box. The Düsseldorf railway station's
English primary name has a German matching alias. Solingen's context includes
the Düsseldorf **subregion**, while Neuss's county is **Rhein-Kreis Neuss**;
neither is settlement evidence for a result in the queried city.

`Bahnhof Krefeld` and `Neuss Marktplatz` are evaluation cases whose intended main
station/square is absent from the captured candidates. Reranking cannot recover
missing candidates. These fixtures test ordering and metadata without network
access; they are not promises about current MapTiler coverage.
