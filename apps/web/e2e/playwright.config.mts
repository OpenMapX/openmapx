import { defineConfig } from "playwright/test";

const fixturePort = 3001;
const webPort = 4311;
const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;

/**
 * Browser journeys against the production build (`pnpm --filter web build`).
 *
 * The app runs from its standalone output with every API, tile and glyph origin
 * pointed at a local fixture server, so nothing leaves the machine. MapLibre
 * needs WebGL2; runners without a GPU get it from SwiftShader.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../test-results/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // Software WebGL on a shared runner draws slowly; a journey that waits for
  // several redraws needs room beyond a single slow frame.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]]
    : "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: [
    {
      command: "node fixture-server.mts",
      cwd: import.meta.dirname,
      url: `${fixtureOrigin}/api/map-config`,
      env: { FIXTURE_PORT: String(fixturePort) },
      stdout: "pipe",
      reuseExistingServer: false,
    },
    {
      command: "node .next/standalone/apps/web/server.js",
      cwd: `${import.meta.dirname}/..`,
      url: `http://127.0.0.1:${webPort}/offline`,
      env: {
        PORT: String(webPort),
        HOSTNAME: "127.0.0.1",
        NEXT_PUBLIC_API_URL: fixtureOrigin,
        INTERNAL_API_URL: fixtureOrigin,
        NEXT_PUBLIC_TILES_URL: `${fixtureOrigin}/tiles/data/openmapx.json`,
        NEXT_PUBLIC_MAP_STYLE_URL: `${fixtureOrigin}/tiles`,
      },
      stdout: "pipe",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
