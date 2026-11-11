import { AppRegistry } from "react-native";
import { readCarDestinations } from "../bridge/receiveCarDestinations";
import { getRuntimeConfig } from "../config/runtimeConfig";
import { getSharedCoordinatorCore } from "../navigation/createCoordinator";
import {
  createInvisibleNavigation,
  type ForegroundNavigation,
} from "../navigation/createForegroundNavigation";
import {
  foregroundCoordinator,
  onForegroundCoordinatorChanged,
} from "../navigation/foregroundCoordinator";
import { deviceMobileLocale } from "../shell/shellCopy";
import { CarCommands } from "./CarCommands";
import { CarSessionAdapter } from "./CarSessionAdapter";
import { nativeCar } from "./nativeCar";
import { publishCarState } from "./publishCarState";
import { prepareAutoDrive, simulatedSessionId, startTestDrive, stopTestDrive } from "./testDrive";

let runtime: Promise<ForegroundNavigation> | null = null;
export function carCoordinator() {
  return foregroundCoordinator() ?? runtime?.then((value) => value.coordinator);
}
let activeTask: Promise<void> | null = null;
export async function startCarRuntime(): Promise<void> {
  if (activeTask) return activeTask;
  activeTask = runCarRuntime().finally(() => {
    activeTask = null;
  });
  return activeTask;
}
async function runCarRuntime(): Promise<void> {
  const native = nativeCar();
  if (!native) return;
  const config = getRuntimeConfig();
  const { repository } = await getSharedCoordinatorCore();
  if (!(await native.isConnected())) return;
  const preferences = await readCarDestinations(config.webOrigin);
  if (preferences) await native.destinations(JSON.stringify(preferences));
  const session = await repository.loadActive(Date.now());
  const locale = session?.locale ?? preferences?.locale ?? deviceMobileLocale();
  await native.configure(
    config.webOrigin,
    locale,
    session?.units ?? preferences?.units ?? "metric",
  );
  const compose = () => createInvisibleNavigation({ apiOrigin: config.apiOrigin, locale });
  let connected = true;
  const ensureOwner = async (): Promise<
    import("../navigation/NavigationCoordinator").NavigationCoordinator
  > => {
    if (!connected) throw new Error("car-disconnected");
    if (foregroundCoordinator()) {
      const previous = runtime;
      runtime = null;
      (await previous)?.dispose();
      const foreground = foregroundCoordinator();
      if (foreground) return foreground;
      return ensureOwner();
    }
    runtime ??= compose();
    return (await runtime).coordinator;
  };
  const unregister = onForegroundCoordinatorChanged(() => {
    void ensureOwner().catch(() => {});
  });
  const commands = new CarCommands(
    native,
    config.webOrigin,
    config.apiOrigin,
    ensureOwner,
    async (geometry) => prepareAutoDrive(geometry, await ensureOwner(), repository),
    () => stopTestDrive(repository),
  );
  let detach: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    detach = resolve;
  });
  const subscription = native.addListener("onCommand", (event) => {
    void (async () => {
      if (event.command === "detach") {
        // A detach from an ended session can arrive after the next session connected;
        // the runtime then keeps serving the new one.
        if (await native.isConnected()) {
          await native.acknowledge(event.command);
          return;
        }
        connected = false;
        commands.disconnect();
        await native.acknowledge(event.command);
        detach();
        return;
      }
      if (await commands.handle(event.command)) {
        await native.acknowledge(event.command);
        return;
      }
      const adapter = new CarSessionAdapter(await ensureOwner(), repository);
      if (event.command === "stop") {
        commands.cancel();
        await stopTestDrive(repository);
        await adapter.stop();
      }
      if (__DEV__ && event.command === "simulate")
        await startTestDrive(await ensureOwner(), repository);
      await publishCarState(repository, Date.now(), true);
      await native.acknowledge(event.command);
    })().catch(async () => {
      await native.result(JSON.stringify({ error: "unavailable" }));
      await native.acknowledge(event.command);
    });
  });
  try {
    await ensureOwner();
    await native.runtimeReady();
    await native.attach();
    if (!(await native.isConnected())) detach();
    await publishCarState(repository, Date.now(), true);
    await finished;
  } finally {
    connected = false;
    commands.disconnect();
    // A simulated trip has no real position to continue on once the car is gone.
    const simulated = simulatedSessionId();
    const owner = foregroundCoordinator() ?? (await runtime)?.coordinator;
    if (owner && simulated && (await repository.loadActive(Date.now()))?.sessionId === simulated)
      await new CarSessionAdapter(owner, repository).stop().catch(() => {});
    await stopTestDrive(repository);
    subscription.remove();
    unregister();
    (await runtime)?.dispose();
    runtime = null;
    await native.detach();
  }
}
AppRegistry.registerHeadlessTask("OpenMapXCarRuntime", () => startCarRuntime);
