import de from "@openmapx/i18n/locales/de.json";
import en from "@openmapx/i18n/locales/en.json";
import { describe, expect, it } from "vitest";
import { translateDataSourceLabel } from "./dataSourceSummaryI18n";

type Translator = Parameters<typeof translateDataSourceLabel>[1];

function translator(catalog: { dataSources: Record<string, unknown> }): Translator {
  return ((key: string) => {
    const value = catalog.dataSources[key];
    if (typeof value !== "string") throw new Error(`missing dataSources.${key}`);
    return value;
  }) as Translator;
}

describe("translateDataSourceLabel", () => {
  it("translates the EV charging filter labels and options in en and de", () => {
    const labels = [
      "Connector",
      "Type 1",
      "Type 2",
      "Type 3",
      "NACS / Tesla",
      "Charging Speed",
      "Slow (≤22 kW)",
      "Fast (≤100 kW)",
      "Ultra-Rapid (>100 kW)",
      "Access",
      "Public",
      "Restricted",
      "Hide out of service",
      "Available now",
    ];

    expect(labels.map((l) => translateDataSourceLabel(l, translator(en)))).toEqual(labels);
    expect(labels.map((l) => translateDataSourceLabel(l, translator(de)))).toEqual([
      "Anschluss",
      "Typ 1",
      "Typ 2",
      "Typ 3",
      "NACS / Tesla",
      "Ladegeschwindigkeit",
      "Langsam (≤22 kW)",
      "Schnell (≤100 kW)",
      "Ultraschnell (>100 kW)",
      "Zugang",
      "Öffentlich",
      "Eingeschränkt",
      "Außer Betrieb ausblenden",
      "Jetzt verfügbar",
    ]);
  });

  it("translates the webcam category filter and its six camera types in en and de", () => {
    const labels = ["Category", "Landscape", "Traffic", "City", "Weather", "Beach", "Other"];

    expect(labels.map((l) => translateDataSourceLabel(l, translator(en)))).toEqual(labels);
    expect(labels.map((l) => translateDataSourceLabel(l, translator(de)))).toEqual([
      "Kategorie",
      "Landschaft",
      "Verkehr",
      "Stadt",
      "Wetter",
      "Strand",
      "Sonstige",
    ]);
  });

  it("translates the message-sign status filter and its options in en and de", () => {
    const labels = ["Status", "Showing a message", "Blank", "Out of order"];

    expect(labels.map((l) => translateDataSourceLabel(l, translator(en)))).toEqual(labels);
    expect(labels.map((l) => translateDataSourceLabel(l, translator(de)))).toEqual([
      "Zustand",
      "Mit Meldung",
      "Ohne Anzeige",
      "Außer Betrieb",
    ]);
  });

  it("translates the road-weather, road-maintenance and border-crossing filters in en and de", () => {
    const labels = [
      "Road surface",
      "Dry",
      "Wet",
      "Snow or slush",
      "Ice or frost",
      "Work",
      "Ploughing",
      "Salting or sanding",
      "Other work",
      "Wait time",
      "Up to 15 min",
      "15 to 45 min",
      "Over 45 min",
      "Closed",
    ];

    expect(labels.map((l) => translateDataSourceLabel(l, translator(en)))).toEqual(labels);
    expect(labels.map((l) => translateDataSourceLabel(l, translator(de)))).toEqual([
      "Fahrbahn",
      "Trocken",
      "Nass",
      "Schnee oder Matsch",
      "Eis oder Reif",
      "Arbeit",
      "Schneeräumen",
      "Salz- oder Sandstreuung",
      "Sonstige Arbeit",
      "Wartezeit",
      "Bis 15 Min.",
      "15 bis 45 Min.",
      "Über 45 Min.",
      "Geschlossen",
    ]);
  });

  it("leaves a language-neutral label as it is", () => {
    expect(translateDataSourceLabel("CCS2", translator(de))).toBe("CCS2");
  });
});
