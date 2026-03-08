/** Centralised list of API endpoint paths. */
export const API_ENDPOINTS = {
  geocode: "/api/geocode",
  geocodeReverse: "/api/geocode/reverse",
  autocomplete: "/api/autocomplete",
  directions: "/api/directions",
  places: "/api/places",
  traffic: "/api/traffic",
  streetViewImages: "/api/streetview/images",
  categorySearch: "/api/places/search",
  fuelPricesDetail: "/api/fuel-prices/detail",
} as const;
