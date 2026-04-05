export interface WeatherCodeInfo {
  description: string;
  /** Meteocons icon name (without `meteocons:` prefix). Use with @iconify/react. */
  icon: string;
  severity: "none" | "light" | "moderate" | "heavy" | "extreme";
}

interface CodeEntry {
  description: string;
  dayIcon: string;
  nightIcon: string;
  severity: WeatherCodeInfo["severity"];
}

/**
 * WMO weather interpretation codes mapped to Basmilius Meteocons (fill variant).
 * Icon names match the `meteocons` iconify set.
 * @see https://github.com/basmilius/weather-icons
 */
const WMO_CODES: Record<number, CodeEntry> = {
  0: {
    description: "Clear sky",
    dayIcon: "clear-day-fill",
    nightIcon: "clear-night-fill",
    severity: "none",
  },
  1: {
    description: "Mainly clear",
    dayIcon: "partly-cloudy-day-fill",
    nightIcon: "partly-cloudy-night-fill",
    severity: "none",
  },
  2: {
    description: "Partly cloudy",
    dayIcon: "partly-cloudy-day-fill",
    nightIcon: "partly-cloudy-night-fill",
    severity: "none",
  },
  3: {
    description: "Overcast",
    dayIcon: "overcast-fill",
    nightIcon: "overcast-fill",
    severity: "none",
  },
  45: {
    description: "Fog",
    dayIcon: "fog-day-fill",
    nightIcon: "fog-night-fill",
    severity: "none",
  },
  48: {
    description: "Depositing rime fog",
    dayIcon: "extreme-day-fog-fill",
    nightIcon: "extreme-night-fog-fill",
    severity: "light",
  },
  51: {
    description: "Light drizzle",
    dayIcon: "partly-cloudy-day-drizzle-fill",
    nightIcon: "partly-cloudy-night-drizzle-fill",
    severity: "light",
  },
  53: {
    description: "Moderate drizzle",
    dayIcon: "overcast-day-drizzle-fill",
    nightIcon: "overcast-night-drizzle-fill",
    severity: "moderate",
  },
  55: {
    description: "Dense drizzle",
    dayIcon: "extreme-day-drizzle-fill",
    nightIcon: "extreme-night-drizzle-fill",
    severity: "moderate",
  },
  56: {
    description: "Light freezing drizzle",
    dayIcon: "overcast-day-sleet-fill",
    nightIcon: "overcast-night-sleet-fill",
    severity: "moderate",
  },
  57: {
    description: "Dense freezing drizzle",
    dayIcon: "extreme-day-sleet-fill",
    nightIcon: "extreme-night-sleet-fill",
    severity: "moderate",
  },
  61: {
    description: "Slight rain",
    dayIcon: "partly-cloudy-day-rain-fill",
    nightIcon: "partly-cloudy-night-rain-fill",
    severity: "light",
  },
  63: {
    description: "Moderate rain",
    dayIcon: "overcast-day-rain-fill",
    nightIcon: "overcast-night-rain-fill",
    severity: "moderate",
  },
  65: {
    description: "Heavy rain",
    dayIcon: "extreme-day-rain-fill",
    nightIcon: "extreme-night-rain-fill",
    severity: "heavy",
  },
  66: {
    description: "Light freezing rain",
    dayIcon: "overcast-day-sleet-fill",
    nightIcon: "overcast-night-sleet-fill",
    severity: "moderate",
  },
  67: {
    description: "Heavy freezing rain",
    dayIcon: "extreme-day-sleet-fill",
    nightIcon: "extreme-night-sleet-fill",
    severity: "heavy",
  },
  71: {
    description: "Slight snowfall",
    dayIcon: "partly-cloudy-day-snow-fill",
    nightIcon: "partly-cloudy-night-snow-fill",
    severity: "light",
  },
  73: {
    description: "Moderate snowfall",
    dayIcon: "overcast-day-snow-fill",
    nightIcon: "overcast-night-snow-fill",
    severity: "moderate",
  },
  75: {
    description: "Heavy snowfall",
    dayIcon: "extreme-day-snow-fill",
    nightIcon: "extreme-night-snow-fill",
    severity: "heavy",
  },
  77: {
    description: "Snow grains",
    dayIcon: "overcast-day-snow-fill",
    nightIcon: "overcast-night-snow-fill",
    severity: "light",
  },
  80: {
    description: "Slight rain showers",
    dayIcon: "partly-cloudy-day-rain-fill",
    nightIcon: "partly-cloudy-night-rain-fill",
    severity: "light",
  },
  81: {
    description: "Moderate rain showers",
    dayIcon: "overcast-day-rain-fill",
    nightIcon: "overcast-night-rain-fill",
    severity: "moderate",
  },
  82: {
    description: "Violent rain showers",
    dayIcon: "extreme-day-rain-fill",
    nightIcon: "extreme-night-rain-fill",
    severity: "heavy",
  },
  85: {
    description: "Slight snow showers",
    dayIcon: "partly-cloudy-day-snow-fill",
    nightIcon: "partly-cloudy-night-snow-fill",
    severity: "light",
  },
  86: {
    description: "Heavy snow showers",
    dayIcon: "extreme-day-snow-fill",
    nightIcon: "extreme-night-snow-fill",
    severity: "heavy",
  },
  95: {
    description: "Thunderstorm",
    dayIcon: "thunderstorms-day-fill",
    nightIcon: "thunderstorms-night-fill",
    severity: "heavy",
  },
  96: {
    description: "Thunderstorm with slight hail",
    dayIcon: "thunderstorms-day-overcast-fill",
    nightIcon: "thunderstorms-night-overcast-fill",
    severity: "extreme",
  },
  99: {
    description: "Thunderstorm with heavy hail",
    dayIcon: "thunderstorms-day-extreme-fill",
    nightIcon: "thunderstorms-night-extreme-fill",
    severity: "extreme",
  },
};

const FALLBACK: CodeEntry = {
  description: "Unknown",
  dayIcon: "overcast-day-fill",
  nightIcon: "overcast-night-fill",
  severity: "none",
};

export function weatherCodeToInfo(code: number, isDay: boolean): WeatherCodeInfo {
  const entry = WMO_CODES[code] ?? FALLBACK;
  return {
    description: entry.description,
    icon: isDay ? entry.dayIcon : entry.nightIcon,
    severity: entry.severity,
  };
}

export function weatherCodeToDescription(code: number): string {
  return (WMO_CODES[code] ?? FALLBACK).description;
}

export function weatherCodeToIcon(code: number, isDay: boolean): string {
  const entry = WMO_CODES[code] ?? FALLBACK;
  return isDay ? entry.dayIcon : entry.nightIcon;
}
