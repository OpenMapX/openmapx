import { type CarDestinations, carDestinationSchema } from "@openmapx/core/navigation";
import { z } from "zod";
import { readCarDestinations } from "../bridge/receiveCarDestinations";
import { createLocationDriver } from "../location/createLocationDriver";
import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import { CarRoutePlanner } from "./CarRoutePlanner";
import type { NativeCar } from "./nativeCar";

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
  private search: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private searchGeneration = 0;
  private commandGeneration = 0;
  constructor(
    private readonly native: NativeCar,
    private readonly webOrigin: string,
    private readonly apiOrigin: string,
    coordinator: () => Promise<NavigationCoordinator>,
  ) {
    this.planner = new CarRoutePlanner(apiOrigin, coordinator, () => ({
      kind: "car",
      hostAuthorized: this.connected,
      locationServiceStartAllowed: this.eligible,
    }));
  }
  cancel() {
    this.commandGeneration++;
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
      this.eligible =
        (await this.native.startEligible()) || (await createLocationDriver().isRunning());
      if (!this.connected || generation !== this.commandGeneration) return true;
      if (!this.eligible) {
        await this.native.result(JSON.stringify({ error: "phone-setup" }));
        return true;
      }
      const routes = await this.planner.plan(
        carDestinationSchema.parse(command.destination),
        preferences,
      );
      if (routes && this.connected && generation === this.commandGeneration) {
        await this.native.preview(
          JSON.stringify({ v: 1, type: "car-preview", routes, selected: 0 }),
        );
        await this.native.result(JSON.stringify({ routes: routes.length }));
      }
    }
    if (command.action === "start") {
      this.eligible =
        (await this.native.startEligible()) || (await createLocationDriver().isRunning());
      if (!this.connected || generation !== this.commandGeneration) return true;
      if (!this.eligible) {
        await this.native.result(JSON.stringify({ error: "phone-setup" }));
        return true;
      }
      const response = await this.planner.start(command.index ?? 0, command.replaceSessionId);
      await this.native.result(
        JSON.stringify({
          started: response?.type === "session.started",
          error: response?.type === "native.error" ? "phone-setup" : undefined,
        }),
      );
    }
    return true;
  }
  private async runSearch(query: string, preferences: CarDestinations, generation: number) {
    const controller = new AbortController();
    this.search = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = new URL("/api/integrations/geocoding/geocode", this.apiOrigin);
      url.searchParams.set("q", query);
      url.searchParams.set("lang", preferences.locale);
      url.searchParams.set("limit", "10");
      const response = await fetch(url.toString(), {
        credentials: "omit",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("unavailable");
      const results = searchResponse
        .parse(await response.json())
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
    } finally {
      clearTimeout(timeout);
    }
  }
}
