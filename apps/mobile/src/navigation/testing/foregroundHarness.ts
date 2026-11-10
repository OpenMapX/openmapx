import {
  MOBILE_PROTOCOL_MAX,
  type MobileNavigationSession,
  type WebToNativeMessage,
  webToNativeSchema,
} from "@openmapx/core/navigation";
import {
  createNavigationAudio,
  type NativeNavigationAudio,
  type SpeakRequest,
  type SpeakResult,
} from "../../audio/navigationAudio";
import {
  getHeadlessCoordinator,
  releaseHeadlessComposition,
} from "../../background/createHeadlessCoordinator";
import type { AuxiliaryCommandHandler } from "../../bridge/answerCommand";
import type { ConnectivityDriver, ConnectivityState } from "../../connectivity/ConnectivityDriver";
import type { RecoveryEvent } from "../../lifecycle/NavigationRecoveryController";
import { type AppActivity, withBackgroundSafeProfiles } from "../../location/backgroundSafeDriver";
import type {
  LocationDriver,
  LocationPermissionState,
  LocationProfile,
  StartOptions,
} from "../../location/LocationDriver";
import type { RawLocation } from "../../location/sanitiseFixes";
import {
  type NotificationScheduler,
  planReconciliation,
  type ReconcileResult,
  type ScheduledNotification,
} from "../../notifications/NotificationScheduler";
import { isOpenMapXNotificationId } from "../../notifications/notificationIds";
import type { PermissionUi } from "../../permissions/permissionController";
import { type Database, prepareDatabase } from "../../storage/database";
import { SessionRepository } from "../../storage/SessionRepository";
import { openTestDatabase } from "../../storage/testing/nodeSqliteDatabase";
import { resetCoordinatorCache } from "../createCoordinator";
import {
  createForegroundNavigation,
  type ForegroundDevice,
  type ForegroundNavigation,
} from "../createForegroundNavigation";
import { foregroundCoordinator } from "../foregroundCoordinator";
import type { NavigationCoordinator, SessionEnded } from "../NavigationCoordinator";

/**
 * The shipped foreground navigation composition, running on a fake phone.
 *
 * `createForegroundNavigation` is built exactly as the app builds it: the real
 * coordinator, repository, processors, effect runner, publish port, permission
 * controller and alert port. Only the device underneath is replaced, through the
 * composition's own `device` seam:
 *
 *  - location: a driver that records starts and stops and delivers fixes the
 *    way the background task does, and only while it is running;
 *  - audio: a native synthesiser behind the real validation wrapper;
 *  - notifications: an in-memory scheduler and grant;
 *  - storage: a real SQLite engine prepared by the app's own `prepareDatabase`,
 *    which survives `relaunch()` the way the database file survives a process;
 *  - clock: time that moves only when a test moves it.
 *
 * The fake device outlives a composition. `relaunch()` drops everything the
 * process held in memory and composes again over the same device, so a test can
 * observe what a killed and restarted app finds.
 */

export const HARNESS_START_MS = 1_700_000_100_000;

export class FakeClock {
  private timers: Array<{ dueAtMs: number; callback: () => void }> = [];
  /**
   * Whether JavaScript timers fire as time passes. Android pauses them while
   * the app is in the background, even with a foreground service running.
   */
  timersPaused = false;

  constructor(private value: number = HARNESS_START_MS) {}

  readonly now = (): number => this.value;

  readonly schedule = (callback: () => void, delayMs: number): (() => void) => {
    const timer = { dueAtMs: this.value + Math.max(0, delayMs), callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((entry) => entry !== timer);
    };
  };

  /** A killed process takes its timers with it; the clock itself carries on. */
  dropTimers(): void {
    this.timers = [];
  }

  /** Timers that have not fired or been cancelled. */
  get pendingTimers(): number {
    return this.timers.length;
  }

  /**
   * Moves time forward, firing each timer that falls due at its own instant and
   * in due order. Work a timer queues still has to be awaited, as with a real one.
   */
  advance(ms: number): void {
    const target = this.value + ms;
    for (;;) {
      if (this.timersPaused) break;
      const next = this.timers
        .filter((timer) => timer.dueAtMs <= target)
        .sort((a, b) => a.dueAtMs - b.dueAtMs)[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.value = Math.max(this.value, next.dueAtMs);
      next.callback();
    }
    this.value = target;
  }
}

/** The operating system's location service for this app. */
export class FakeLocation implements LocationDriver {
  permission: LocationPermissionState = "background";
  accuracy: "precise" | "approximate" = "precise";
  running = false;
  profile: LocationProfile | null = null;
  /** Every start and stop, in order, so a test can see restarts as well as state. */
  readonly calls: Array<"start" | "stop"> = [];
  locale: "en" | "de" | null = null;

  /**
   * `timeline` is shared with other fakes, so a test can see what happened
   * first. On Android, starting the stream needs the app in the foreground.
   */
  constructor(
    private readonly timeline: string[] = [],
    private readonly os: "ios" | "android" = "ios",
    private readonly app: { visible: boolean } = { visible: true },
  ) {}

  setLocale(locale: "en" | "de"): void {
    this.locale = locale;
  }

  async getPermissionState(): Promise<LocationPermissionState> {
    return this.permission;
  }

  async requestForegroundPermission(): Promise<LocationPermissionState> {
    return this.permission;
  }

  async requestBackgroundPermission(): Promise<LocationPermissionState> {
    return this.permission;
  }

  /**
   * Behaves like expo-location under `ExpoLocationDriver`: the same profile is
   * a no-op, a different one stops the stream and starts it again, and on
   * Android the start throws `ForegroundServiceStartNotAllowedException` unless
   * the app is in the foreground, after the stop has already happened.
   */
  async start(profile: LocationProfile, options: StartOptions = {}): Promise<void> {
    if (this.running && this.profile && sameProfile(this.profile, profile)) return;
    if (this.running && options.mayRestart && !options.mayRestart()) return;
    if (this.running) await this.stop();
    if (this.os === "android" && !this.app.visible) {
      throw new Error("ForegroundServiceStartNotAllowedException");
    }
    this.calls.push("start");
    this.timeline.push("location:start");
    this.running = true;
    this.profile = profile;
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
    this.timeline.push("location:stop");
    this.running = false;
    this.profile = null;
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }

  async getCurrentFix(): Promise<null> {
    return null;
  }

  readPermission() {
    return Promise.resolve({
      permission: this.permission,
      ...(this.permission === "denied" || this.permission === "not-determined"
        ? {}
        : { accuracy: this.accuracy }),
      canAskAgain: true,
    });
  }
}

/** The platform speech synthesiser, as the native module presents it. */
export class FakeSpeech implements NativeNavigationAudio {
  readonly spoken: SpeakRequest[] = [];
  stops = 0;
  /** What the next utterances report; a muted or interrupted device skips. */
  result: SpeakResult = "spoken";
  available = true;

  constructor(private readonly timeline: string[] = []) {}

  async speak(request: SpeakRequest): Promise<SpeakResult> {
    if (this.result === "spoken") {
      this.spoken.push(request);
      this.timeline.push(`speak:${request.cueId}`);
    }
    return this.result;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  get cueIds(): string[] {
    return this.spoken.map((request) => request.cueId);
  }
}

/** The local notification store and its grant. */
export class FakeNotifications implements NotificationScheduler {
  granted = true;
  canAskAgain = true;
  readonly scheduled = new Map<string, ScheduledNotification>();

  async prepare(): Promise<void> {}

  async scheduleAlight(request: ScheduledNotification): Promise<void> {
    this.scheduled.set(request.id, request);
  }

  async scheduleCriticalInterruption(request: ScheduledNotification): Promise<void> {
    this.scheduled.set(request.id, request);
  }

  async cancel(id: string): Promise<void> {
    this.scheduled.delete(id);
  }

  async cancelSession(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.scheduled.delete(id);
  }

  async pending(): Promise<string[]> {
    return [...this.scheduled.keys()];
  }

  async reconcile(records: readonly ScheduledNotification[]): Promise<ReconcileResult> {
    const plan = planReconciliation(records, await this.pending(), isOpenMapXNotificationId);
    for (const id of plan.toCancel) this.scheduled.delete(id);
    for (const record of plan.toSchedule) this.scheduled.set(record.id, record);
    return {
      scheduled: plan.toSchedule.length,
      cancelled: plan.toCancel.length,
      orphans: plan.orphans.length,
    };
  }
}

/**
 * The network as `fetch` sees it. Refuses every request until a test supplies
 * an answer, so remote work that a scenario did not plan for fails visibly.
 */
export class FakeNetwork {
  readonly requests: string[] = [];
  respond: (url: string, init?: RequestInit) => Promise<Response> = async () => {
    throw new TypeError("Network request failed");
  };

  /** Like the platform's `fetch`, an aborted request rejects at once. */
  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.requests.push(url);
    const signal = init?.signal;
    if (!signal) return this.respond(url, init);
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
      this.respond(url, init).then(resolve, reject);
    });
  };
}

/**
 * Internet reachability as the platform reports it: a change is reported once,
 * when it happens, and a state that holds produces no further report.
 */
export class FakeConnectivity implements ConnectivityDriver {
  private state: ConnectivityState = "online";
  private listeners = new Set<(state: ConnectivityState) => void>();

  current(): ConnectivityState {
    return this.state;
  }

  subscribe(listener: (state: ConnectivityState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(state: ConnectivityState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  /** A killed process takes its subscriptions with it. */
  dropListeners(): void {
    this.listeners.clear();
  }
}

/** The persistent store, standing in for the database file. */
export class FakeStorage {
  readonly file: Database = openTestDatabase();

  /** Opens it the way the app does on every process start. */
  open(): Promise<Database> {
    return prepareDatabase(this.file);
  }

  close(): Promise<void> {
    return this.file.closeAsync();
  }
}

/** Whether the user can see the app, which the start flow and keep-awake ask. */
export class FakeApp implements AppActivity {
  visible = true;
  private listeners = new Set<() => void>();

  isActive(): boolean {
    return this.visible;
  }

  onActive(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Brings the app to the front or sends it away, telling listeners on activation. */
  setVisible(visible: boolean): void {
    const activated = visible && !this.visible;
    this.visible = visible;
    if (activated) for (const listener of this.listeners) listener();
  }

  /** A killed process takes its listeners with it. */
  dropListeners(): void {
    this.listeners.clear();
  }
}

/** The screen's wake lock. */
export class FakeKeepAwake {
  held = false;
  /** Every change, in order, so a test can see a release and a re-hold. */
  readonly calls: Array<"activate" | "deactivate"> = [];

  async activate(): Promise<void> {
    this.calls.push("activate");
    this.held = true;
  }

  async deactivate(): Promise<void> {
    this.calls.push("deactivate");
    this.held = false;
  }
}

/** The native screens a start can show. Accepting is the default answer. */
export class FakePermissionScreens implements PermissionUi {
  readonly shown: string[] = [];
  disclosure: "accept" | "foreground-only" | "dismiss" = "accept";

  async showDisclosure() {
    this.shown.push("disclosure");
    return this.disclosure;
  }

  async showSettingsRequired() {
    this.shown.push("settings-required");
    return "dismiss" as const;
  }

  async offerForegroundOnly() {
    this.shown.push("foreground-only");
    return "dismiss" as const;
  }

  async showDenied() {
    this.shown.push("denied");
  }

  async openSystemSettings() {
    this.shown.push("system-settings");
  }
}

export interface FakePhone {
  os: "ios" | "android";
  /** Location starts and stops and spoken cues, in the order they happened. */
  timeline: string[];
  clock: FakeClock;
  location: FakeLocation;
  speech: FakeSpeech;
  notifications: FakeNotifications;
  network: FakeNetwork;
  connectivity: FakeConnectivity;
  storage: FakeStorage;
  app: FakeApp;
  keepAwake: FakeKeepAwake;
  permissionScreens: FakePermissionScreens;
}

export function createFakePhone(options: { os?: "ios" | "android" } = {}): FakePhone {
  const timeline: string[] = [];
  const os = options.os ?? "ios";
  const app = new FakeApp();
  return {
    os,
    timeline,
    clock: new FakeClock(),
    location: new FakeLocation(timeline, os, app),
    speech: new FakeSpeech(timeline),
    notifications: new FakeNotifications(),
    network: new FakeNetwork(),
    connectivity: new FakeConnectivity(),
    storage: new FakeStorage(),
    app,
    keepAwake: new FakeKeepAwake(),
    permissionScreens: new FakePermissionScreens(),
  };
}

/** A message the composition sent to the page. */
export interface SentMessage {
  type: string;
  payload: unknown;
  sessionId?: string;
  revision?: number;
  forMessageId?: string;
}

export interface ForegroundHarness {
  phone: FakePhone;
  navigation: ForegroundNavigation;
  /** Everything sent to the page, in order, across this composition's lifetime. */
  sent: SentMessage[];
  /** Each guidance start or stop the shell was told about. */
  navigatingReports: boolean[];
  /** Each session end the shell was told about, in order. */
  sessionEnds: SessionEnded[];
  /** The recovery outcome of each visibility change, as the shell receives it. */
  recoveryEvents: RecoveryEvent[];
  /** Sends a page command as the shell dispatches it and returns the reply the page received. */
  command(
    type: WebToNativeMessage["type"],
    payload?: unknown,
    stamp?: { sessionId?: string; revision?: number; messageId?: string },
  ): Promise<SentMessage | null>;
  /** Prepares and starts a session the way the page does, failing loudly on refusal. */
  start(startPackage: unknown): Promise<{ sessionId: string; revision: number }>;
  /**
   * Delivers a batch as the background task does when the app is alive. A
   * stopped stream delivers nothing, so this reports whether it was delivered.
   */
  deliver(locations: readonly RawLocation[]): Promise<boolean>;
  /** The user brings the app to the front or leaves it, and the shell runs recovery. */
  setVisible(visible: boolean): Promise<void>;
  /** The committed session, read from storage. */
  session(): Promise<MobileNavigationSession | null>;
  /** Waits for every queued coordinator operation and its remote work. */
  settle(): Promise<void>;
  /** Lets `ms` of clock time pass with no location delivered, then settles. */
  elapse(ms: number): Promise<void>;
  /**
   * The user stands still at `lngLat` for `ms`. The stream delivers on its
   * profile's time interval only if that profile has no distance filter, which
   * is what a stationary device gets from either platform.
   */
  standStill(lngLat: readonly [number, number], ms: number): Promise<void>;
  /** The process dies and the app is started again on the same phone. */
  relaunch(): Promise<ForegroundHarness>;
  /**
   * The process dies with the app out of sight, and the operating system
   * starts it again for a location batch, with no app and no page.
   */
  relaunchHeadless(): Promise<HeadlessHarness>;
  /** Disposes this composition and closes the phone's storage. */
  shutdown(): Promise<void>;
}

export interface HarnessOptions {
  phone?: FakePhone;
  /** Answers the page's one-shot requests; declines them by default. */
  auxiliary?: AuxiliaryCommandHandler;
  locale?: "en" | "de";
  apiOrigin?: string;
}

/**
 * The phone as every composition sees it. The visible app's and the headless
 * composition get the same ports, as `createForegroundNavigation` does in
 * production.
 */
function phoneDevice(phone: FakePhone): ForegroundDevice {
  return {
    // The wrapper `createLocationDriver` puts around the platform driver.
    driver: withBackgroundSafeProfiles(phone.location, phone.os, phone.app),
    platform: phone.os === "android" ? { os: "android", sdkInt: 34 } : { os: "ios" },
    app: phone.app,
    connectivity: phone.connectivity,
    readLocationPermission: () => phone.location.readPermission(),
    audio: createNavigationAudio(phone.speech),
    speechAvailable: () => phone.speech.available,
    notifications: {
      scheduler: phone.notifications,
      permission: async () => ({
        granted: phone.notifications.granted,
        canAskAgain: phone.notifications.canAskAgain,
      }),
      request: async () => phone.notifications.granted,
    },
    openStorage: () => phone.storage.open(),
    keepAwake: phone.keepAwake,
    clock: phone.clock.now,
    schedule: phone.clock.schedule,
  };
}

/** A killed process takes its timers, listeners and compositions with it. */
function killProcess(phone: FakePhone): void {
  phone.clock.dropTimers();
  phone.app.dropListeners();
  phone.connectivity.dropListeners();
  releaseHeadlessComposition();
}

let messageCounter = 0;

/** Composes the shipped foreground navigation on a fake phone. */
export async function startForegroundHarness(
  options: HarnessOptions = {},
): Promise<ForegroundHarness> {
  const phone = options.phone ?? createFakePhone();
  // A new process: nothing composed before survives except the phone itself.
  resetCoordinatorCache();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: phone.network.fetch,
  });

  const sent: SentMessage[] = [];
  const navigatingReports: boolean[] = [];
  const sessionEnds: SessionEnded[] = [];
  const recoveryEvents: RecoveryEvent[] = [];
  const device = phoneDevice(phone);

  const navigation = await createForegroundNavigation({
    apiOrigin: options.apiOrigin ?? "https://api.openmapx.test",
    locale: options.locale ?? "en",
    send: (type, payload, stamp) => {
      sent.push({ type, payload, ...stamp });
      return "sent";
    },
    permissionUi: phone.permissionScreens,
    isAppActive: () => phone.app.visible,
    auxiliary: options.auxiliary ?? (async () => null),
    onNavigatingChanged: (navigating) => navigatingReports.push(navigating),
    onSessionEnded: (ended) => sessionEnds.push(ended),
    device,
  });
  const repository = new SessionRepository(phone.storage.file);

  const settle = async () => {
    await navigation.coordinator.settle();
    await navigation.coordinator.settleRemoteWork();
  };

  const harness: ForegroundHarness = {
    phone,
    navigation,
    sent,
    navigatingReports,
    sessionEnds,
    recoveryEvents,
    async command(type, payload = {}, stamp = {}) {
      messageCounter += 1;
      const messageId = stamp.messageId ?? `harness-${messageCounter}`;
      // Parsed by the same schema the shell applies to every page message, so a
      // scenario cannot send something the real bridge would refuse.
      const command = webToNativeSchema.parse({
        protocolVersion: MOBILE_PROTOCOL_MAX,
        type,
        messageId,
        channelNonce: "harness-nonce",
        sentAtMs: phone.clock.now(),
        payload,
        ...(stamp.sessionId === undefined ? {} : { sessionId: stamp.sessionId }),
        ...(stamp.revision === undefined ? {} : { revision: stamp.revision }),
      });
      await navigation.dispatch(command);
      await settle();
      return sent.find((message) => message.forMessageId === messageId) ?? null;
    },
    async start(startPackage) {
      const prepared = await harness.command("session.prepare", { startPackage });
      if (prepared?.type !== "session.prepared") {
        throw new Error(`prepare refused: ${JSON.stringify(prepared?.payload)}`);
      }
      const { sessionId, revision } = prepared.payload as { sessionId: string; revision: number };
      const started = await harness.command("session.start", {}, { sessionId, revision });
      if (started?.type !== "session.started") {
        throw new Error(`start refused: ${JSON.stringify(started?.payload)}`);
      }
      return started.payload as { sessionId: string; revision: number };
    },
    async deliver(locations) {
      if (!phone.location.running) return false;
      const coordinator = foregroundCoordinator();
      if (!coordinator) throw new Error("no foreground coordinator is registered");
      await coordinator.handleLocationBatch({ locations });
      await settle();
      return true;
    },
    async setVisible(visible) {
      phone.app.setVisible(visible);
      // Work started by an activation listener is not awaited by anyone.
      await new Promise((resolve) => setImmediate(resolve));
      await settle();
      // The shell reconciles on every visibility change, as App.tsx does.
      recoveryEvents.push(await navigation.recovery.reconcile(visible ? "active" : "background"));
      await settle();
      await navigation.reviewForegroundWork();
    },
    session: () => repository.loadActive(phone.clock.now()),
    settle,
    async elapse(ms) {
      phone.clock.advance(ms);
      await settle();
    },
    async standStill(lngLat, ms) {
      const until = phone.clock.now() + ms;
      while (phone.clock.now() < until) {
        const profile = phone.location.profile;
        const step = Math.min(profile?.timeIntervalMs ?? 1_000, until - phone.clock.now());
        phone.clock.advance(step);
        await settle();
        if (profile && profile.distanceIntervalMeters === 0 && phone.location.profile === profile) {
          await harness.deliver([rawFix(phone.clock, lngLat, { speed: 0 })]);
        }
      }
    },
    async relaunch() {
      navigation.dispose();
      killProcess(phone);
      return startForegroundHarness({ ...options, phone });
    },
    async relaunchHeadless() {
      navigation.dispose();
      killProcess(phone);
      phone.app.setVisible(false);
      return startHeadlessHarness({ ...options, phone });
    },
    async shutdown() {
      await settle();
      navigation.dispose();
      await phone.storage.close();
    },
  };
  return harness;
}

/** A process the operating system started for location batches, with no app. */
export interface HeadlessHarness {
  phone: FakePhone;
  coordinator: NavigationCoordinator;
  /**
   * Delivers a batch as the background task does: to the visible app's
   * composition if one exists, otherwise to the headless one. A stopped stream
   * delivers nothing.
   */
  deliver(locations: readonly RawLocation[]): Promise<boolean>;
  session(): Promise<MobileNavigationSession | null>;
  /** Waits as the background task does before it reports the batch handled. */
  settle(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Composes the shipped headless navigation on a fake phone, as the background task does. */
export async function startHeadlessHarness(options: HarnessOptions = {}): Promise<HeadlessHarness> {
  const phone = options.phone ?? createFakePhone();
  resetCoordinatorCache();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: phone.network.fetch,
  });
  const coordinator = await getHeadlessCoordinator({
    apiOrigin: options.apiOrigin ?? "https://api.openmapx.test",
    device: phoneDevice(phone),
  });
  const repository = new SessionRepository(phone.storage.file);
  const settle = async () => {
    await coordinator.settle();
    await coordinator.settleRemoteWork();
    await coordinator.settle();
  };
  return {
    phone,
    coordinator,
    async deliver(locations) {
      if (!phone.location.running) return false;
      const owner = foregroundCoordinator() ?? coordinator;
      await owner.handleLocationBatch({ locations });
      await settle();
      return true;
    },
    session: () => repository.loadActive(phone.clock.now()),
    settle,
    async shutdown() {
      await settle();
      killProcess(phone);
      await phone.storage.close();
    },
  };
}

/** A raw platform fix, timestamped now unless told otherwise. */
export function rawFix(
  clock: FakeClock,
  lngLat: readonly [number, number],
  extra: { accuracy?: number; speed?: number; heading?: number; ageMs?: number } = {},
): RawLocation {
  return {
    timestamp: clock.now() - (extra.ageMs ?? 0),
    coords: {
      longitude: lngLat[0],
      latitude: lngLat[1],
      accuracy: extra.accuracy ?? 5,
      speed: extra.speed ?? 20,
      ...(extra.heading === undefined ? {} : { heading: extra.heading }),
    },
  };
}

/**
 * A straight drive east, 300 points about 71 m apart, with a single turn after
 * 10 km. Long enough to hear every voice stage of the turn and then arrive.
 */
export const STRAIGHT_ROUTE: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: 300 },
  (_, index) => [8.68 + index * 0.001, 50.11] as const,
);

export function groundStartPackage(
  settings: Partial<{
    voiceEnabled: boolean;
    keepScreenOn: boolean;
    voiceTiming: "early" | "normal" | "late";
  }> = {},
) {
  const destination = STRAIGHT_ROUTE[STRAIGHT_ROUTE.length - 1];
  return {
    kind: "ground" as const,
    route: {
      distance: 21_000,
      duration: 1_200,
      geometry: STRAIGHT_ROUTE.map((point) => [...point]),
      mode: "driving",
      steps: [
        {
          instruction: "Head east on Beispielstraße",
          verbalSuccinct: "Head east",
          verbalAlert: "Head east now",
          distance: 10_000,
          duration: 600,
          name: "Beispielstraße",
        },
        {
          instruction: "Turn left onto Zweite Straße",
          verbalSuccinct: "Turn left",
          verbalAlert: "Turn left now",
          distance: 11_000,
          duration: 600,
          name: "Zweite Straße",
        },
      ],
    },
    alternatives: [],
    mode: "driving" as const,
    destinationWaypoints: [[destination[0], destination[1]]],
    routeSelectionIntent: "automatic" as const,
    routeOptions: {},
    locale: "en" as const,
    units: "metric" as const,
    settings: {
      voiceEnabled: true,
      keepScreenOn: true,
      voiceTiming: "normal" as const,
      ...settings,
    },
  };
}

/** Drives along `STRAIGHT_ROUTE` from index `from` up to (not including) `to`, one fix a second. */
export async function driveStraightRoute(
  harness: ForegroundHarness,
  from: number,
  to: number,
): Promise<void> {
  for (let index = from; index < to; index += 1) {
    harness.phone.clock.advance(1_000);
    await harness.deliver([rawFix(harness.phone.clock, STRAIGHT_ROUTE[index])]);
  }
}

function sameProfile(a: LocationProfile, b: LocationProfile): boolean {
  return (
    a.accuracy === b.accuracy &&
    a.timeIntervalMs === b.timeIntervalMs &&
    a.distanceIntervalMeters === b.distanceIntervalMeters &&
    a.activityType === b.activityType
  );
}
