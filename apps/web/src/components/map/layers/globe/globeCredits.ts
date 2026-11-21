import type { Attribution } from "@openmapx/mobility-core/attribution";

/**
 * Credits for the globe's bundled textures; see `apps/web/public/globe/README.md`.
 * Publisher names are proper nouns and are not translated.
 */

export const MILKY_WAY_ATTRIBUTION: Attribution = {
  sourceId: "eso-milky-way",
  name: "ESO/S. Brunier",
  url: "https://www.eso.org/public/images/eso0932a/",
  licensing: {
    version: 1,
    bindings: [
      {
        scope: "data",
        subject: "ESO all-sky Milky Way panorama (eso0932a), resized",
        license: { kind: "spdx", expression: "CC-BY-4.0" },
      },
    ],
  },
};

export const NIGHT_LIGHTS_ATTRIBUTION: Attribution = {
  sourceId: "nasa-black-marble",
  name: "NASA Earth Observatory",
  url: "https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps/",
  licensing: {
    version: 1,
    bindings: [
      {
        scope: "data",
        subject: "NASA Black Marble 2016 night lights, resized",
        license: {
          kind: "public-domain",
          name: "U.S. Public Domain",
          url: "https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance",
        },
      },
    ],
  },
};
