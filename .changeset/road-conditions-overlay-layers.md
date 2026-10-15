---
"@openmapx/i18n": minor
"web": minor
---

The "Traffic incidents" overlay becomes "Road conditions" and gathers what is
known about the road in one place. Its legend lists the layers it can show: the
incidents, on by default, and message signs, road weather, road maintenance
vehicles and border crossings, off by default and listed only where the server
has a source for them. A shown layer explains its marker colours or says when
nothing is in the area, draws its markers with its own glyph for the area in
view as the map moves, opens them in the place panel and credits their sources.
The incident filters show while the incidents do.

Those four categories leave the category bar, which now honours a data source
manifest's `showInChipBar`; search still finds them by name.
