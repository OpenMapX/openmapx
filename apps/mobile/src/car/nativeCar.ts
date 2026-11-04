import { requireOptionalNativeModule } from "expo";
export interface NativeCar {
  result(json: string): Promise<void>;
  startEligible(): Promise<boolean>;
  isConnected(): Promise<boolean>;
  destinations(json: string): Promise<void>;
  runtimeReady(): Promise<void>;
  configure(origin: string, locale: "en" | "de", units: "metric" | "imperial"): Promise<void>;
  publish(json: string): Promise<void>;
  preview(json: string): Promise<void>;
  acknowledge(command: string): Promise<void>;
  detach(): Promise<void>;
  attach(): Promise<void>;
  addListener(
    event: "onCommand",
    listener: (event: { command: string }) => void,
  ): { remove(): void };
}
export function nativeCar(): NativeCar | null {
  return requireOptionalNativeModule<NativeCar>("OpenMapXAndroidAuto");
}
