import { describe, expect, it } from "vitest";
import { mainStopKey, stopNameKey, stopNameSpecificity } from "../stop-names.js";

describe("stopNameKey", () => {
  it("gives one key to the spellings sources use for one stop", () => {
    const key = stopNameKey("Köln Hbf");
    expect(stopNameKey("Köln Hauptbahnhof")).toBe(key);
    expect(stopNameKey("Hauptbahnhof, Köln")).toBe(key);
    expect(stopNameKey("Koln Hbf")).toBe(key);
    expect(stopNameKey("KÖLN HBF")).toBe(key);
  });

  it("drops parenthesised qualifiers, as place-to-stop linking does", () => {
    expect(stopNameKey("Frankfurt(Main)Hbf")).toBe(stopNameKey("Frankfurt Hauptbahnhof"));
    expect(stopNameKey("Berlin Hbf (tief)")).toBe(stopNameKey("Berlin Hbf"));
  });

  it("drops platform designations, which name a part of the stop", () => {
    expect(stopNameKey("München Hbf Gl.27-36")).toBe(stopNameKey("München Hbf"));
    expect(stopNameKey("S+U Berlin Hauptbahnhof [Gleis 1-8]")).toBe(stopNameKey("Berlin Hbf"));
    expect(stopNameKey("Köln Hbf Gleis 9")).toBe(stopNameKey("Köln Hbf"));
    expect(stopNameKey("Glockenturm")).toBe("glockenturm");
    expect(stopNameKey("Steigerwaldstadion")).toBe("steigerwaldstadion");
  });

  it("drops words saying only that a stop is a station, but not Hauptbahnhof", () => {
    expect(stopNameKey("Köln Messe/Deutz Bf")).toBe(stopNameKey("Köln Messe/Deutz"));
    expect(stopNameKey("Köln Messe/Deutz Bahnhof")).toBe(stopNameKey("Köln Messe/Deutz"));
    expect(stopNameKey("Köln Bf Deutz/Messe/LANXESS arena")).not.toBe(
      stopNameKey("Köln Messe/Deutz"),
    );
    expect(stopNameKey("Köln Hbf")).not.toBe(stopNameKey("Köln"));
  });

  it("drops single-letter mode prefixes", () => {
    expect(stopNameKey("S+U Berlin Hauptbahnhof")).toBe(stopNameKey("Berlin Hbf"));
    expect(stopNameKey("S+U Hauptbahnhof/Washingtonplatz (Berlin)")).not.toBe(
      stopNameKey("Berlin Hbf"),
    );
  });

  it("keeps different stops apart", () => {
    expect(stopNameKey("Köln Breslauer Platz/Hbf")).not.toBe(stopNameKey("Köln Hbf"));
    expect(stopNameKey("Dom/Hbf")).not.toBe(stopNameKey("Köln Hbf"));
    expect(stopNameKey("Hauptbahnhof Nord, München")).not.toBe(stopNameKey("München Hbf"));
  });
});

describe("stopNameSpecificity", () => {
  it("counts the words of a key", () => {
    expect(stopNameSpecificity(stopNameKey("Köln Breslauer Platz/Hbf"))).toBeGreaterThan(
      stopNameSpecificity(stopNameKey("Köln Hbf")),
    );
    expect(stopNameSpecificity("")).toBe(0);
  });
});

describe("mainStopKey", () => {
  it("prefers the stop named like the place", () => {
    const hbf = stopNameKey("Köln Hbf");
    const bus = stopNameKey("Köln Breslauer Platz/Hbf");
    expect(
      mainStopKey(
        "Köln Hauptbahnhof",
        new Map([
          [bus, 9],
          [hbf, 1],
        ]),
      ),
    ).toBe(hbf);
  });

  it("prefers the stop the place was opened for when it is on the board", () => {
    const hbf = stopNameKey("Köln Hbf");
    const bus = stopNameKey("Köln Breslauer Platz/Hbf");
    const rows = new Map([
      [hbf, 9],
      [bus, 2],
    ]);
    expect(mainStopKey("Köln Hbf", rows, "Breslauer Platz/Hauptbahnhof, Köln")).toBe(bus);
    expect(mainStopKey("Köln Hbf", rows, "Köln Ehrenfeld")).toBe(hbf);
  });

  it("breaks a similarity tie by the number of departures", () => {
    const a = stopNameKey("Markt Nord");
    const b = stopNameKey("Markt Süd");
    expect(
      mainStopKey(
        "Markt",
        new Map([
          [a, 2],
          [b, 5],
        ]),
      ),
    ).toBe(b);
  });
});
