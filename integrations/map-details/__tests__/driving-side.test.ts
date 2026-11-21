import { describe, expect, it } from "vitest";
import { isLeftHandTraffic } from "../web/derive/driving-side";
import { LEFT_HAND_TRAFFIC_REGIONS } from "../web/derive/driving-side-regions";

describe("driving side", () => {
  it.each([
    ["London", -0.12, 51.5],
    ["Tokyo", 139.7, 35.7],
    ["Hong Kong", 114.17, 22.3],
    ["Singapore", 103.85, 1.29],
    ["Sydney", 151.2, -33.87],
    ["Johannesburg", 28.05, -26.2],
    ["Mumbai", 72.88, 19.08],
    ["Valletta", 14.51, 35.9],
    ["Nong Khai", 102.75, 17.87],
  ])("drives on the left in %s", (_name, lng, lat) => {
    expect(isLeftHandTraffic(lng, lat)).toBe(true);
  });

  it.each([
    ["Berlin", 13.4, 52.5],
    ["Gibraltar", -5.35, 36.14],
    ["Paris", 2.35, 48.86],
    ["New York", -74, 40.7],
    ["Shenzhen", 114.06, 22.6],
    ["Zhuhai", 113.55, 22.27],
    ["Vientiane", 102.6, 17.97],
    ["mid-Atlantic", -30, 30],
  ])("drives on the right in %s", (_name, lng, lat) => {
    expect(isLeftHandTraffic(lng, lat)).toBe(false);
  });

  it("keeps the embedded regions small", () => {
    expect(JSON.stringify(LEFT_HAND_TRAFFIC_REGIONS).length).toBeLessThanOrEqual(12 * 1024);
  });
});
