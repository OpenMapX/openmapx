import {
  type CarDestinations,
  carDestinationSchema,
  measurementDistanceParts,
} from "@openmapx/core/navigation";
import { createApiClient, fetchGeocode } from "@openmapx/core/navigation/api";
import { z } from "zod";
import { readCarDestinations } from "../bridge/receiveCarDestinations";
import { createLocationDriver } from "../location/createLocationDriver";
import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import { CarRoutePlanner, carPlanError } from "./CarRoutePlanner";
import type { NativeCar } from "./nativeCar";

/**
 * Where Android Auto's simulated test drive starts (NF-7). The instance's routing and
 * search cover Germany only, so the drive happens in Berlin wherever the reviewer is.
 */
// South of Alexanderplatz: the route to the Brandenburg Gate starts without a U-turn.
export const AUTO_DRIVE_ORIGIN: [number, number] = [13.4124, 52.5194];

const EMPTY_PREVIEW = JSON.stringify({ v: 1, type: "car-preview", routes: [] });
/** Start refusals the driver can only resolve on the phone. */
const PHONE_SETUP_CODES = new Set(["app-not-visible", "permission-denied"]);

const searchResponse = z
  .array(
    z
      .object({
        id: z.string().optional(),
        label: z.string(),
        coordinates: z.tuple([z.number(), z.number()]),
      })
      .passthrough(),
  )
  .max(100);
/** Owns cancellable public requests; raw URLs and coordinates never reach logs. */
export class CarCommands {
  private planner: CarRoutePlanner;
  private connected = true;
  private eligible = false;
  private previewing = false;
  /** Set only by the host's `onAutoDriveEnabled`; lasts for this car session. */
  private autoDrive = false;
  private search: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private searchGeneration = 0;
  private commandGeneration = 0;
  constructor(
    private readonly native: NativeCar,
    private readonly webOrigin: string,
    private readonly apiOrigin: string,
    coordinator: () => Promise<NavigationCoordinator>,
    private readonly prepareAutoDrive: (
      geometry: readonly (readonly [number, number])[],
    ) => Promise<void> = async () => {},
    private readonly stopAutoDrive: () => Promise<void> = async () => {},
  ) {
    this.planner = new CarRoutePlanner(apiOrigin, coordinator, () => ({
      kind: "car",
      hostAuthorized: this.connected,
      locationServiceStartAllowed: this.eligible,
    }));
  }
  cancel() {
    this.commandGeneration++;
    if (this.previewing) {
      this.previewing = false;
      void this.native.preview(EMPTY_PREVIEW).catch(() => {});
    }
    this.planner.cancel();
    this.searchGeneration++;
    this.search?.abort();
    if (this.timer) clearTimeout(this.timer);
  }
  disconnect() {
    this.connected = false;
    this.cancel();
  }
  async handle(raw: string): Promise<boolean> {
    if (raw === "destinations-changed") {
      this.cancel();
      return true;
    }
    if (raw === "auto-drive") {
      this.autoDrive = true;
      return true;
    }
    if (!raw.startsWith("car:")) return false;
    const command = JSON.parse(raw.slice(4)) as {
      action?: string;
      destination?: unknown;
      query?: string;
      index?: number;
      replaceSessionId?: string;
    };
    if (command.action === "cancel") {
      this.cancel();
      return true;
    }
    const generation =
      command.action === "plan" ? ++this.commandGeneration : this.commandGeneration;
    const preferences = await readCarDestinations(this.webOrigin);
    if (!this.connected || generation !== this.commandGeneration) return true;
    if (!preferences) {
      await this.native.result(JSON.stringify({ error: "phone-setup" }));
      return true;
    }
    if (command.action === "search") {
      this.searchGeneration++;
      const generation = this.searchGeneration;
      this.search?.abort();
      if (this.timer) clearTimeout(this.timer);
      const query = command.query?.trim().slice(0, 160) ?? "";
      if (!query) {
        await this.native.result(JSON.stringify({ results: [] }));
        return true;
      }
      this.timer = setTimeout(() => {
        void this.runSearch(query, preferences, generation);
      }, 350);
    }
    if (command.action === "plan") {
      // Choosing a place ends the search: a late result must not replace the plan's result.
      this.searchGeneration++;
      this.search?.abort();
      if (this.timer) clearTimeout(this.timer);
      // A simulated drive needs no location service, so the phone's state does not gate it.
      this.eligible =
        this.autoDrive ||
        (await this.native.startEligible()) ||
        (await createLocationDriver().isRunning());
      if (!this.connected || generation !== this.commandGeneration) return true;
      if (!this.eligible) {
        await this.native.result(JSON.stringify({ error: "phone-setup" }));
        return true;
      }
      let routes: Awaited<ReturnType<CarRoutePlanner["plan"]>>;
      try {
        routes = await this.planner.plan(
          carDestinationSchema.parse(command.destination),
          preferences,
          this.autoDrive ? AUTO_DRIVE_ORIGIN : undefined,
        );
      } catch (error) {
        if (this.connected && generation === this.commandGeneration)
          await this.native.result(JSON.stringify({ error: carPlanError(error) }));
        return true;
      }
      if (routes && this.connected && generation === this.commandGeneration) {
        this.previewing = true;
        await this.native.preview(
          JSON.stringify({
            v: 1,
            type: "car-preview",
            routes: routes.map((route) => ({ coordinates: route.coordinates })),
            selected: 0,
          }),
        );
        await this.native.result(
          JSON.stringify({
            routes: routes.map(({ durationSeconds, distanceMeters }) => ({
              durationSeconds,
              distanceMeters,
              distance: measurementDistanceParts(distanceMeters, preferences.units),
            })),
          }),
        );
      }
    }
    if (command.action === "select" && this.previewing) {
      const routes = this.planner.previewRoutes();
      const index = command.index ?? 0;
      if (index >= 0 && index < routes.length)
        await this.native.preview(
          JSON.stringify({ v: 1, type: "car-preview", routes, selected: index }),
        );
    }
    if (command.action === "start") {
      this.eligible =
        this.autoDrive ||
        (await this.native.startEligible()) ||
        (await createLocationDriver().isRunning());
      if (!this.connected || generation !== this.commandGeneration) return true;
      if (!this.eligible) {
        await this.native.result(JSON.stringify({ error: "phone-setup" }));
        return true;
      }
      const geometry = this.autoDrive ? this.planner.candidateGeometry(command.index ?? 0) : null;
      if (geometry) await this.prepareAutoDrive(geometry);
      const response = await this.planner.start(command.index ?? 0, command.replaceSessionId);
      const started = response?.type === "session.started";
      if (geometry && !started) await this.stopAutoDrive();
      if (started && this.previewing) {
        // A replayed preview would pull a reconnecting car out of follow mode.
        this.previewing = false;
        await this.native.preview(EMPTY_PREVIEW);
      }
      const code =
        response?.type === "native.error"
          ? (response.payload as { code?: string }).code
          : undefined;
      await this.native.result(
        JSON.stringify({
          started,
          error: started
            ? undefined
            : code && PHONE_SETUP_CODES.has(code)
              ? "phone-setup"
              : "unavailable",
        }),
      );
    }
    return true;
  }
  private async runSearch(query: string, preferences: CarDestinations, generation: number) {
    const controller = new AbortController();
    this.search = controller;
    try {
      // Rank places near the car first, as the phone search does.
      const near = this.autoDrive
        ? AUTO_DRIVE_ORIGIN
        : ((
            await createLocationDriver()
              .getCurrentFix({ accuracy: "balanced", maxAgeMs: 300000, timeoutMs: 2000 })
              .catch(() => null)
          )?.coords ?? null);
      if (generation !== this.searchGeneration || !this.connected) return;
      // The phone search's request, through the shared client (errors, abort, timeout).
      const places = await fetchGeocode(
        { q: query, lang: preferences.locale, proximity: near, limit: 10 },
        createApiClient({ baseUrl: this.apiOrigin, credentials: "omit" }),
        { signal: controller.signal, timeoutMs: 15000 },
      );
      const results = searchResponse
        .parse(places)
        .flatMap((place, index) => {
          const result = carDestinationSchema.safeParse({
            id: place.id ?? `search-${index}`,
            label: place.label.slice(0, 160),
            coordinates: place.coordinates,
          });
          return result.success ? [result.data] : [];
        })
        .slice(0, 10);
      if (generation === this.searchGeneration && this.connected)
        await this.native.result(JSON.stringify({ results }));
    } catch {
      if (generation === this.searchGeneration && this.connected)
        await this.native.result(JSON.stringify({ error: "search-unavailable" }));
    }
  }
}
