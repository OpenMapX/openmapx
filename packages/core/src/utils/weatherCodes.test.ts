import { describe, expect, it } from "vitest";
import { weatherCodeToDescription, weatherCodeToInfo } from "./weatherCodes";

describe("WMO 4677 mixed, hail-shower and heavy-thunderstorm codes", () => {
  it.each([
    [
      68,
      "Light rain and snow",
      "light",
      "partly-cloudy-day-sleet-fill",
      "partly-cloudy-night-sleet-fill",
    ],
    [69, "Rain and snow", "moderate", "overcast-day-sleet-fill", "overcast-night-sleet-fill"],
    [
      83,
      "Light rain and snow showers",
      "light",
      "partly-cloudy-day-sleet-fill",
      "partly-cloudy-night-sleet-fill",
    ],
    [
      84,
      "Rain and snow showers",
      "moderate",
      "overcast-day-sleet-fill",
      "overcast-night-sleet-fill",
    ],
    [
      89,
      "Light hail showers",
      "moderate",
      "partly-cloudy-day-hail-fill",
      "partly-cloudy-night-hail-fill",
    ],
    [90, "Hail showers", "heavy", "overcast-day-hail-fill", "overcast-night-hail-fill"],
    [
      97,
      "Heavy thunderstorm",
      "extreme",
      "thunderstorms-day-extreme-fill",
      "thunderstorms-night-extreme-fill",
    ],
  ])("describes code %i as %s", (code, description, severity, dayIcon, nightIcon) => {
    expect(weatherCodeToInfo(code, true)).toEqual({ description, severity, icon: dayIcon });
    expect(weatherCodeToInfo(code, false).icon).toBe(nightIcon);
  });

  it("keeps unmapped codes on the unknown fallback", () => {
    expect(weatherCodeToDescription(70)).toBe("Unknown");
  });
});
