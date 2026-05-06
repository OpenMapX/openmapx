import { createDatexParkingProvider } from "./datex-parking-provider.js";

const provider = createDatexParkingProvider({
  sourceId: "cita-lu",
  sourceName: "CITA Luxembourg",
  sourceUrl: "https://www.cita.lu/",
  tableUrl: "https://www.cita.lu/info_trafic/datex/parking_static.xml",
  statusUrl: "https://www.cita.lu/info_trafic/datex/parking_dynamic.xml",
  coverage: { south: 49.4, west: 5.7, north: 50.2, east: 6.6 },
  parkingType: "surface",
  attribution: {
    name: "CITA Luxembourg",
    url: "https://www.cita.lu/",
    license: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
});

export const searchCitaLu = provider.search;
export const fetchCitaLuDetail = provider.fetchDetail;
