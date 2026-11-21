# Globe textures

Textures for the zoomed-out globe's sky and night side, drawn by
`apps/web/src/components/map/layers/globe/GlobeSkyLayer.ts`. They load only
while globe view is on. These images are not covered by OpenMapX's code
licence; each keeps the licence below. Both originals were retrieved on
21 November 2026.

## night-lights.webp

A 4096 × 2048 grayscale reduction of NASA's 2016 Black Marble global
composite of Earth at night (13500 × 6750, 3 km per pixel). It is
equirectangular, north at the top, longitude −180° at the left edge. It shows
an annual composite of artificial light, not a live view.

- Source: [NASA Earth at Night flat maps](https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/),
  file `BlackMarble_2016_3km_gray.jpg`.
- Credit: NASA Earth Observatory, using Suomi NPP VIIRS data processed at
  NASA's Goddard Space Flight Center.
- Licence: U.S. public domain (NASA imagery is not subject to copyright in the
  United States; see
  [NASA's data use guidance](https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance)).

Prepared with:

```sh
magick BlackMarble_2016_3km_gray.jpg -filter Lanczos -resize '4096x2048!' -colorspace Gray night.png
cwebp -q 82 -m 6 night.png -o night-lights.webp
```

## milky-way.webp

A 2048 × 1024 reduction of ESO's photographic all-sky panorama of the Milky
Way (6000 × 3000). It is in galactic coordinates: the Galactic Centre in the
middle, galactic longitude increasing to the left, galactic north at the top.
The renderer turns it into Earth's frame using sidereal time.

- Source: [ESO image eso0932a](https://www.eso.org/public/images/eso0932a/),
  file `https://cdn.eso.org/images/large/eso0932a.jpg`.
- Credit: ESO/S. Brunier.
- Licence: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
  ([ESO copyright notice](https://www.eso.org/public/copyright/)). Changes:
  resized and recompressed; brightness is reduced when drawn.

Prepared with:

```sh
magick eso0932a.jpg -filter Lanczos -resize '2048x1024!' milky.png
cwebp -q 78 -m 6 milky.png -o milky-way.webp
```
