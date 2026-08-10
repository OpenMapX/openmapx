import { getDatabase } from "../storage/database";
import { SessionRepository } from "../storage/SessionRepository";
import { type EffectPorts, EffectRunner } from "./effects";
import { GroundNavigationProcessor } from "./ground/GroundNavigationProcessor";
import {
  type BridgePort,
  type CoordinatorDeps,
  type DriverPort,
  NavigationCoordinator,
  type PermissionPort,
} from "./NavigationCoordinator";
import { type AnyNavigationProcessor, ProcessorRegistry } from "./processor";
import { TransitNavigationProcessor } from "./transit/TransitNavigationProcessor";

/**
 * Production composition.
 *
 * Ground navigation is registered here; transit arrives with its own plan, and
 * until then the shell reports that capability as false rather than accept a
 * session it cannot actually run.
 *
 * The foreground app and the headless task both come through here, and both get
 * the same repository over the same single connection — that shared connection
 * is what makes the compare-and-swap between them meaningful.
 */

export interface CoordinatorComposition {
  coordinator: NavigationCoordinator;
  repository: SessionRepository;
  processors: ProcessorRegistry;
}

export interface CoordinatorOverrides {
  bridge: BridgePort;
  permissions: PermissionPort;
  driver: DriverPort;
  ports: EffectPorts;
  clock?: () => number;
  newSessionId?: () => string;
}

/** Random enough to be unique, and meaningless on its own. */
function randomSessionId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let composition: Promise<CoordinatorComposition> | null = null;

/**
 * One coordinator per process, created on first use.
 *
 * Memoised on the promise rather than the value, so a location callback arriving
 * while the UI is still starting cannot produce a second authority over the same
 * database.
 */
export function createCoordinator(
  overrides: CoordinatorOverrides,
): Promise<CoordinatorComposition> {
  composition ??= (async () => {
    const repository = new SessionRepository(await getDatabase());
    const processors = new ProcessorRegistry();
    for (const mode of registeredModes()) {
      const factory = PROCESSOR_FACTORIES[mode];
      if (factory) processors.register(factory());
    }

    const deps: CoordinatorDeps = {
      repository,
      processors,
      effects: new EffectRunner(overrides.ports),
      bridge: overrides.bridge,
      permissions: overrides.permissions,
      driver: overrides.driver,
      diagnostics: overrides.ports.diagnostics,
      clock: overrides.clock ?? (() => Date.now()),
      newSessionId: overrides.newSessionId ?? randomSessionId,
    };

    return { coordinator: new NavigationCoordinator(deps), repository, processors };
  })().catch((error) => {
    composition = null;
    throw error;
  });
  return composition;
}

/** Test seam: drops the memoised coordinator so a suite can supply its own. */
export function resetCoordinatorCache(): void {
  composition = null;
}

/**
 * The one place a mode becomes available.
 *
 * Both the registration and the capability reported in the handshake read this
 * map, so the shell cannot promise the page a mode it has no processor for.
 * `null` is an explicit "not yet", not an omission.
 */
const PROCESSOR_FACTORIES: Record<"ground" | "transit", (() => AnyNavigationProcessor) | null> = {
  ground: () => new GroundNavigationProcessor(),
  transit: () => new TransitNavigationProcessor(),
};

/**
 * The modes this build can actually run.
 *
 * A plain function over the map rather than a query against a live registry,
 * because the handshake can happen before the database has finished opening.
 */
export function registeredModes(): ReadonlyArray<"ground" | "transit"> {
  const modes: Array<"ground" | "transit"> = [];
  for (const mode of ["ground", "transit"] as const) {
    if (PROCESSOR_FACTORIES[mode]) modes.push(mode);
  }
  return modes;
}
