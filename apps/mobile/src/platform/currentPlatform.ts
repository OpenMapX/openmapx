import { Platform } from "react-native";

/** The platform description the permission flow and location profiles need. */
export function currentPlatform(): { os: "ios" } | { os: "android"; sdkInt: number } {
  return Platform.OS === "android"
    ? { os: "android", sdkInt: typeof Platform.Version === "number" ? Platform.Version : 0 }
    : { os: "ios" };
}
