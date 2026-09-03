import type { BenchmarkSource, BenchmarkValue, RegionalBenchmark } from "./types";

const SOURCES = {
  euFuel: {
    citation: "European Commission Weekly Oil Bulletin",
    url: "https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en",
    effectiveAt: "2026-01-01",
    scope: "Indicative national consumer price fallback; live station prices are preferred",
  },
  eurostatElectricity: {
    citation: "Eurostat household electricity prices",
    url: "https://ec.europa.eu/eurostat/databrowser/view/nrg_pc_204/default/table",
    effectiveAt: "2025-H1",
    scope: "Household electricity price including taxes, representative consumption band",
  },
  eeaGrid: {
    citation: "EEA greenhouse gas intensity of electricity generation",
    url: "https://www.eea.europa.eu/en/analysis/indicators/greenhouse-gas-emission-intensity-of-1/greenhouse-gas-emission-intensity-1",
    effectiveAt: "2024",
    scope: "Gross public electricity generation; not a lifecycle or marginal grid factor",
  },
  ukEnergy: {
    citation: "UK DESNZ and Ofgem energy statistics",
    url: "https://www.gov.uk/government/collections/quarterly-energy-prices",
    effectiveAt: "2026-Q1",
    scope: "Indicative UK consumer energy price fallback",
  },
  usEnergy: {
    citation: "US EIA energy prices",
    url: "https://www.eia.gov/electricity/data/browser/",
    effectiveAt: "2026",
    scope: "Indicative US consumer energy price fallback",
  },
  usGrid: {
    citation: "US EPA eGRID",
    url: "https://www.epa.gov/egrid",
    effectiveAt: "2024",
    scope: "US electricity output emissions factor",
  },
  swissEnergy: {
    citation: "Swiss Federal Office of Energy statistics",
    url: "https://www.bfe.admin.ch/bfe/en/home/supply/statistics-and-geodata.html",
    effectiveAt: "2025",
    scope: "Indicative Swiss consumer energy and generation fallback",
  },
  norwayEnergy: {
    citation: "Statistics Norway energy statistics",
    url: "https://www.ssb.no/en/energi-og-industri/energi",
    effectiveAt: "2025",
    scope: "Indicative Norwegian consumer energy and generation fallback",
  },
  global: {
    citation: "OpenMapX global fallback model 2026.1",
    url: "https://github.com/openmapx/openmapx",
    effectiveAt: "2026-01-01",
    scope: "Coarse fallback used only when geography and currency are unknown",
  },
} as const satisfies Record<string, BenchmarkSource>;

function value(
  amount: number,
  unit: BenchmarkValue["unit"],
  source: BenchmarkSource,
): BenchmarkValue {
  return { value: amount, unit, source };
}

function region(
  countryCode: string,
  currency: string,
  values: [number, number, number, number],
  sources: {
    fuel: BenchmarkSource;
    electricity: BenchmarkSource;
    grid: BenchmarkSource;
  },
): RegionalBenchmark {
  return {
    countryCode,
    currency,
    petrolPricePerLiter: value(values[0], "per_liter", sources.fuel),
    dieselPricePerLiter: value(values[1], "per_liter", sources.fuel),
    electricityPricePerKwh: value(values[2], "per_kwh", sources.electricity),
    gridCarbonIntensityGramsPerKwh: value(values[3], "grams_co2e_per_kwh", sources.grid),
  };
}

const EUROPEAN_SOURCES = {
  fuel: SOURCES.euFuel,
  electricity: SOURCES.eurostatElectricity,
  grid: SOURCES.eeaGrid,
};

export const REGIONAL_BENCHMARKS: Readonly<Record<string, Readonly<RegionalBenchmark>>> = {
  DE: region("DE", "EUR", [1.78, 1.66, 0.3835, 380], EUROPEAN_SOURCES),
  FR: region("FR", "EUR", [1.82, 1.71, 0.27, 55], EUROPEAN_SOURCES),
  AT: region("AT", "EUR", [1.64, 1.62, 0.29, 110], EUROPEAN_SOURCES),
  CH: region("CH", "CHF", [1.8, 1.88, 0.32, 40], {
    fuel: SOURCES.swissEnergy,
    electricity: SOURCES.swissEnergy,
    grid: SOURCES.swissEnergy,
  }),
  GB: region("GB", "GBP", [1.45, 1.55, 0.28, 190], {
    fuel: SOURCES.ukEnergy,
    electricity: SOURCES.ukEnergy,
    grid: SOURCES.ukEnergy,
  }),
  US: region("US", "USD", [0.92, 1, 0.18, 370], {
    fuel: SOURCES.usEnergy,
    electricity: SOURCES.usEnergy,
    grid: SOURCES.usGrid,
  }),
  NO: region("NO", "NOK", [21.5, 20.8, 1.4, 25], {
    fuel: SOURCES.norwayEnergy,
    electricity: SOURCES.norwayEnergy,
    grid: SOURCES.norwayEnergy,
  }),
  EU: region("EU", "EUR", [1.75, 1.65, 0.2872, 230], EUROPEAN_SOURCES),
  GLOBAL: region("GLOBAL", "EUR", [1.7, 1.6, 0.3, 350], {
    fuel: SOURCES.global,
    electricity: SOURCES.global,
    grid: SOURCES.global,
  }),
};

const EU_COUNTRY_CODES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

export function getRegionalBenchmark(
  countryCode?: string | null,
  currency?: string | null,
): RegionalBenchmark {
  const normalizedCountry = countryCode?.trim().toUpperCase();
  if (normalizedCountry) {
    const mappedCountry = normalizedCountry === "UK" ? "GB" : normalizedCountry;
    if (mappedCountry in REGIONAL_BENCHMARKS) return REGIONAL_BENCHMARKS[mappedCountry];
    if (EU_COUNTRY_CODES.has(mappedCountry)) return REGIONAL_BENCHMARKS.EU;
    return REGIONAL_BENCHMARKS.GLOBAL;
  }

  const currencyRegion: Readonly<Record<string, string>> = {
    USD: "US",
    GBP: "GB",
    CHF: "CH",
    NOK: "NO",
    EUR: "EU",
  };
  const mappedCurrency = currency ? currencyRegion[currency.trim().toUpperCase()] : undefined;
  return mappedCurrency ? REGIONAL_BENCHMARKS[mappedCurrency] : REGIONAL_BENCHMARKS.GLOBAL;
}
