import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "OpenMapX",
  slug: "openmapx",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  // Deep linking: Expo Router maps openmapx:// URLs to file routes automatically.
  // Examples: openmapx://place/osm:node:123, openmapx://directions, openmapx://category/restaurant
  scheme: "openmapx",
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "org.openmapx.app",
    associatedDomains: [`webcredentials:${process.env.EXPO_PUBLIC_PASSKEY_RP_ID ?? "localhost"}`],
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#ffffff",
      foregroundImage: "./assets/images/icon.png",
    },
    package: "org.openmapx.app",
  },
  plugins: [
    "expo-router",
    "expo-localization",
    "expo-secure-store",
    "@maplibre/maplibre-react-native",
    [
      "expo-location",
      {
        locationAlwaysAndWhenInUsePermission: "Allow OpenMapX to use your location.",
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
});
