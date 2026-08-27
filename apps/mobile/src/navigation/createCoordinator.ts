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
import { SerialExecutor } from "./serialExecutor";
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

export interface SharedCoordinatorCore {
  repository: SessionRepository;
  processors: ProcessorRegistry;
  executor: SerialExecutor;
}

let sharedCore: Promise<SharedCoordinatorCore> | null = null;

export function getSharedCoordinatorCore(): Promise<SharedCoordinatorCore> {
  sharedCore ??= (async () => {
    const repository = new SessionRepository(await getDatabase());
    const processors = new ProcessorRegistry();
    for (const mode of registeredModes()) {
      const factory = PROCESSOR_FACTORIES[mode];
      if (factory) processors.register(factory());
    }
    return { repository, processors, executor: new SerialExecutor() };
  })().catch((error) => {
    sharedCore = null;
    throw error;
  });
  return sharedCore;
}

/**
 * One durable authority per process, with one coordinator per environment.
 *
 * The repository, processors and executor are shared so foreground commands and
 * headless callbacks cannot interleave mutations. Bridge, permission, driver and
 * effect ports remain attached to the environment that supplied them; whichever
 * environment initializes first therefore cannot capture the other one's I/O.
 */
export async function createCoordinator(
  overrides: CoordinatorOverrides,
): Promise<CoordinatorComposition> {
  const { repository, processors, executor } = await getSharedCoordinatorCore();
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

  return {
    coordinator: new NavigationCoordinator(deps, executor),
    repository,
    processors,
  };
}

/** Test seam: drops the memoised durable authority so a suite can supply its own. */
export function resetCoordinatorCache(): void {
  sharedCore = null;
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
