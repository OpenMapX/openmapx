import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isComponentId } from "@openmapx/core/component-id";
import { describeThrown, loggableThrown } from "@openmapx/integration-framework";
import { processLogger } from "./process-logger";
import { raiseAttention, resolveAttention } from "./services/attention";

/**
 * Whether installed integrations are kept out of this process, and why:
 * `env` when `OPENMAPX_SAFE_MODE=1` forces it, `operator` when an operator
 * turned it on, `automatic` when the API stopped repeatedly while installed
 * code was loading or running, with the integration it blames when that is
 * known.
 */
export interface SafeModeState {
  active: boolean;
  reason: "env" | "operator" | "automatic" | null;
  integrationId: string | null;
}

export class SafeModeForcedError extends Error {
  constructor() {
    super("Safe mode is forced by OPENMAPX_SAFE_MODE");
    this.name = "SafeModeForcedError";
  }
}

export const SAFE_MODE_FILE = "safe-mode.json";
export const BOOT_MARKER_FILE = "boot-marker.json";
export const SAFE_MODE_ATTENTION_KEY = "safe-mode";

const CONTAINER_RUNTIME_DIR = "/var/lib/openmapx/runtime";
const INACTIVE: SafeModeState = { active: false, reason: null, integrationId: null };
const OPERATOR: SafeModeState = { active: true, reason: "operator", integrationId: null };

/** The directory the API keeps its own runtime files in, which survives a restart. */
export function apiRuntimeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENMAPX_API_RUNTIME_DIR?.trim();
  if (configured) return configured;
  return env.NODE_ENV === "production"
    ? CONTAINER_RUNTIME_DIR
    : join(tmpdir(), "openmapx-api-runtime");
}

/**
 * The safe mode `env` and `<runtimeDir>/safe-mode.json` ask for. A file that
 * exists but cannot be read or understood counts as the operator's: a damaged
 * file must not let the code that stopped the API load again.
 */
export function readSafeMode(env: NodeJS.ProcessEnv, runtimeDir: string): SafeModeState {
  if (env.OPENMAPX_SAFE_MODE === "1") return { active: true, reason: "env", integrationId: null };
  let text: string;
  try {
    text = readFileSync(join(runtimeDir, SAFE_MODE_FILE), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { ...INACTIVE } : { ...OPERATOR };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...OPERATOR };
  }
  if (parsed === null || typeof parsed !== "object") return { ...OPERATOR };
  const { mode, integrationId } = parsed as { mode?: unknown; integrationId?: unknown };
  // Automatic safe mode names the integration it blames when it knows one.
  if (mode === "automatic" && integrationId === null)
    return { active: true, reason: "automatic", integrationId: null };
  if (mode === "automatic" && typeof integrationId === "string" && isComponentId(integrationId))
    return { active: true, reason: "automatic", integrationId };
  return { ...OPERATOR };
}

/**
 * What the API process leaves in `<runtimeDir>/boot-marker.json` so the next
 * process can tell how it ended. `running` stays true until a stop is
 * requested; a process that ends with it true ended uncleanly.
 */
export interface BootMarker {
  version: 1;
  running: boolean;
  /** Whether this process started loading an installed integration's code. */
  installedCodeStarted: boolean;
  current: { integrationId: string; phase: "import" | "setup" } | null;
  lastFatal: { integrationId: string | null; at: string } | null;
  uncleanExits: Array<{ at: string; integrationId: string | null }>;
}

const UNCLEAN_EXIT_WINDOW_MS = 10 * 60_000;
const UNCLEAN_EXITS_FOR_SAFE_MODE = 3;

function emptyBootMarker(): BootMarker {
  return {
    version: 1,
    running: false,
    installedCodeStarted: false,
    current: null,
    lastFatal: null,
    uncleanExits: [],
  };
}

function integrationIdOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && isComponentId(value) ? value : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseBootMarker(text: string): BootMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyBootMarker();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return emptyBootMarker();
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1) return emptyBootMarker();
  const marker = emptyBootMarker();
  marker.running = raw.running === true;
  marker.installedCodeStarted = raw.installedCodeStarted === true;
  const current = raw.current as Record<string, unknown> | null | undefined;
  if (
    current &&
    typeof current === "object" &&
    typeof current.integrationId === "string" &&
    isComponentId(current.integrationId) &&
    (current.phase === "import" || current.phase === "setup")
  )
    marker.current = { integrationId: current.integrationId, phase: current.phase };
  const lastFatal = raw.lastFatal as Record<string, unknown> | null | undefined;
  if (lastFatal && typeof lastFatal === "object" && validTimestamp(lastFatal.at)) {
    const integrationId = integrationIdOrNull(lastFatal.integrationId);
    if (integrationId !== undefined) marker.lastFatal = { integrationId, at: lastFatal.at };
  }
  if (Array.isArray(raw.uncleanExits))
    for (const entry of raw.uncleanExits as unknown[]) {
      if (entry === null || typeof entry !== "object") continue;
      const { at, integrationId } = entry as Record<string, unknown>;
      const id = integrationIdOrNull(integrationId);
      if (validTimestamp(at) && id !== undefined)
        marker.uncleanExits.push({ at, integrationId: id });
    }
  return marker;
}

/**
 * The marker in `runtimeDir`. A missing, unreadable or malformed one is an
 * empty one: a damaged marker must never by itself put the API in safe mode.
 */
export function readBootMarker(runtimeDir: string): BootMarker {
  try {
    return parseBootMarker(readFileSync(join(runtimeDir, BOOT_MARKER_FILE), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
      warnMarkerOnce(error, "Could not read the boot marker; counting it as empty");
    return emptyBootMarker();
  }
}

/**
 * Replaces `path` with `text` so a reader sees the old or the new file whole,
 * also after a power loss: written beside it, flushed, then renamed over it.
 */
function writeFileDurably(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  try {
    // The rename itself is durable once the directory is flushed.
    const directory = openSync(join(path, ".."), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // Not every file system lets a directory be opened for flushing.
  }
}

let markerProblemLogged = false;

/** A marker that cannot be read or written costs only automatic safe mode, so it is logged once. */
function warnMarkerOnce(error: unknown, message: string): void {
  if (markerProblemLogged) return;
  markerProblemLogged = true;
  try {
    processLogger.warn({ err: loggableThrown(error) }, message);
  } catch {
    // Logging must not stop a fatal handler from exiting.
  }
}

interface ProcessBoot {
  runtimeDir: string;
  running: boolean;
  installedCodeStarted: boolean;
  current: BootMarker["current"];
  lastFatal: BootMarker["lastFatal"];
}

/** This process's part of the marker; null until `beginBoot` ran in this process. */
let boot: ProcessBoot | null = null;
let automaticSafeModeEnteredAtBoot = false;

/**
 * Writes this process's fields. The unclean exits are taken from the file as
 * it is, so clearing them from outside (`control safe-mode off`) holds.
 */
function writeProcessBoot(uncleanExits?: BootMarker["uncleanExits"]): void {
  if (!boot) return;
  try {
    const marker: BootMarker = {
      version: 1,
      running: boot.running,
      installedCodeStarted: boot.installedCodeStarted,
      current: boot.current,
      lastFatal: boot.lastFatal,
      uncleanExits: uncleanExits ?? readBootMarker(boot.runtimeDir).uncleanExits,
    };
    writeFileDurably(
      join(boot.runtimeDir, BOOT_MARKER_FILE),
      `${JSON.stringify(marker, null, 2)}\n`,
    );
  } catch (error) {
    warnMarkerOnce(error, "Could not write the boot marker; automatic safe mode is unavailable");
  }
}

/** The id the most exits name, or null when none or several share the most. */
function mostNamedIntegration(exits: BootMarker["uncleanExits"]): string | null {
  const counts = new Map<string, number>();
  for (const { integrationId } of exits)
    if (integrationId) counts.set(integrationId, (counts.get(integrationId) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  let tied = false;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) tied = true;
  }
  return tied ? null : best;
}

/**
 * Starts this process's boot marker and decides whether this boot runs in
 * automatic safe mode. The previous process counts as an unclean exit only
 * when it was still running and had started installed code: a database
 * outage, a failed platform migration or a kill before any installed
 * integration was loaded does not. At the third unclean exit within ten
 * minutes, `safe-mode.json` asks for automatic safe mode, naming the
 * integration the exits name most often.
 */
export function beginBoot(
  runtimeDir: string,
  now: Date,
): { enterSafeMode: boolean; integrationId: string | null } {
  automaticSafeModeEnteredAtBoot = false;
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  } catch {
    // Reading and writing below report the problem.
  }
  const previous = readBootMarker(runtimeDir);
  let exits = previous.uncleanExits;
  if (previous.running && previous.installedCodeStarted)
    exits = [
      ...exits,
      {
        at: now.toISOString(),
        // The fatal error's async context is direct evidence; the integration
        // that was loading only says what ran at the time, and an integration
        // loaded earlier may fail from a timer while another one loads.
        integrationId: previous.lastFatal?.integrationId ?? previous.current?.integrationId ?? null,
      },
    ];
  // An exit timed after now was recorded before the clock went back; it is
  // dropped rather than kept for longer than the window.
  exits = exits.filter((exit) => {
    const age = now.getTime() - Date.parse(exit.at);
    return age >= 0 && age <= UNCLEAN_EXIT_WINDOW_MS;
  });
  let result: { enterSafeMode: boolean; integrationId: string | null } = {
    enterSafeMode: false,
    integrationId: null,
  };
  if (exits.length >= UNCLEAN_EXITS_FOR_SAFE_MODE) {
    const integrationId = mostNamedIntegration(exits);
    try {
      writeFileDurably(
        join(runtimeDir, SAFE_MODE_FILE),
        `${JSON.stringify({ mode: "automatic", integrationId })}\n`,
      );
      exits = [];
      result = { enterSafeMode: true, integrationId };
      automaticSafeModeEnteredAtBoot = true;
    } catch (error) {
      try {
        processLogger.error(
          { err: loggableThrown(error), integrationId },
          "The API stopped repeatedly, but automatic safe mode could not be turned on",
        );
      } catch {
        // The start goes on without automatic safe mode.
      }
    }
  }
  boot = {
    runtimeDir,
    running: true,
    installedCodeStarted: false,
    current: null,
    lastFatal: null,
  };
  writeProcessBoot(exits);
  return result;
}

/**
 * Called by the integration host before it imports an installed integration
 * and before it runs its `setup`. From the first call on, an unclean exit of
 * this process counts, also one long after loading finished.
 */
export function markIntegrationLoading(integrationId: string, phase: "import" | "setup"): void {
  if (!boot) return;
  if (!boot.installedCodeStarted) {
    boot.installedCodeStarted = true;
    // Before the first byte of installed code runs, so a start that this
    // code freezes is watched.
    try {
      installedCodeStartListener?.();
    } catch (error) {
      try {
        processLogger.warn(
          { err: loggableThrown(error) },
          "Could not start watching the start-up of installed code",
        );
      } catch {
        // Loading goes on unwatched.
      }
    }
  }
  boot.current = { integrationId, phase };
  writeProcessBoot();
}

let installedCodeStartListener: (() => void) | null = null;

/** Called once per process, as the host is about to import the first installed integration. */
export function onInstalledCodeStart(listener: (() => void) | null): void {
  installedCodeStartListener = listener;
}

export function markIntegrationLoaded(): void {
  if (!boot || boot.current === null) return;
  boot.current = null;
  writeProcessBoot();
}

/** Synchronous, for the fatal handler just before the process exits. */
export function recordFatal(integrationId: string | null): void {
  if (!boot) return;
  boot.lastFatal = { integrationId, at: new Date().toISOString() };
  writeProcessBoot();
}

/**
 * A stop was requested. Whatever happens afterwards, even a kill because the
 * shutdown took too long, the process counts as stopped cleanly.
 */
export function markCleanStop(): void {
  if (!boot?.running) return;
  boot.running = false;
  writeProcessBoot();
}

/** Forgets the unclean exits counted so far and keeps the rest of the marker. */
function clearUncleanExits(runtimeDir: string): void {
  if (boot?.runtimeDir === runtimeDir) {
    writeProcessBoot([]);
    return;
  }
  const path = join(runtimeDir, BOOT_MARKER_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  try {
    const marker = parseBootMarker(text);
    writeFileDurably(path, `${JSON.stringify({ ...marker, uncleanExits: [] }, null, 2)}\n`);
  } catch (error) {
    warnMarkerOnce(error, "Could not write the boot marker; automatic safe mode is unavailable");
  }
}

let state: SafeModeState = { ...INACTIVE };
let runtimeDirectory = apiRuntimeDirectory();

/** What safe mode needs of the integration host, which reads safe mode itself. */
export interface SafeModeHost {
  reload(): Promise<unknown>;
  integrationName(integrationId: string): string | undefined;
  /** The reload after leaving failed: what safe mode held back is now a failed load. */
  reloadFailed(message: string): void;
}

let host: SafeModeHost | null = null;

/** Set by the integration host as it is loaded. */
export function setSafeModeHost(next: SafeModeHost | null): void {
  host = next;
}

/**
 * Reads the safe mode once, as the API starts and before any integration is
 * loaded. It holds for the life of the process: a reload keeps it, and only
 * `leaveSafeMode` or a restart without the file and the variable end it.
 */
export function initSafeMode(
  env: NodeJS.ProcessEnv = process.env,
  runtimeDir: string = apiRuntimeDirectory(env),
): SafeModeState {
  runtimeDirectory = runtimeDir;
  state = readSafeMode(env, runtimeDir);
  return getSafeMode();
}

export function getSafeMode(): SafeModeState {
  return { ...state };
}

export function isSafeModeActive(): boolean {
  return state.active;
}

function integrationName(integrationId: string): string {
  const name = host?.integrationName(integrationId);
  return typeof name === "string" && name.trim() ? name.trim() : integrationId;
}

function attentionDetail(current: SafeModeState): string {
  if (current.reason === "env")
    return "OPENMAPX_SAFE_MODE=1 is set for the API, so no installed extension is loaded. To leave safe mode, remove the variable from infra/docker/.env, then run pnpm openmapx compose up on the host, which recreates the api container with the changed environment.";
  if (current.reason === "automatic" && current.integrationId)
    return `The API stopped three times within ten minutes while ${integrationName(current.integrationId)} (${current.integrationId}) was loading or running, so no installed extension is loaded. Disable or update that extension, then leave safe mode.`;
  if (current.reason === "automatic")
    // A crash in built-in code after installed code started counts too, so
    // this text does not take an extension's fault for granted.
    return "OpenMapX stopped three times within ten minutes after installed extensions had started loading, so installed extensions were not loaded. The crashes name no extension: find the error OpenMapX stopped with at the end of the API log, disable or update the extension it names, then leave safe mode. If it names none, the cause may be in OpenMapX itself.";
  return "Safe mode was turned on, so no installed extension is loaded. Leave it in the integration list, or run openmapx control safe-mode off on the host.";
}

/**
 * Raises the safe-mode attention item while safe mode is on and resolves it
 * otherwise. Runs after the integrations are loaded, so the item can name the
 * integration automatic safe mode blames. A failure is logged and does not
 * stop the API.
 */
export async function syncSafeModeAttention(): Promise<void> {
  try {
    if (!state.active) {
      await resolveAttention(SAFE_MODE_ATTENTION_KEY);
      return;
    }
    const automatic = state.reason === "automatic";
    // An item an administrator acknowledged keeps its texts through a raise
    // of the same severity. One left from before the crashes, because its
    // resolution at that boot failed, must not hide why this boot is in
    // safe mode.
    if (automatic && automaticSafeModeEnteredAtBoot)
      await resolveAttention(SAFE_MODE_ATTENTION_KEY);
    await raiseAttention({
      key: SAFE_MODE_ATTENTION_KEY,
      severity: "warning",
      source: "safe-mode",
      title: automatic ? "Safe mode after repeated crashes" : "Safe mode is on",
      detail: attentionDetail(state),
      action: { label: "Leave safe mode", href: "/admin/integrations" },
    });
  } catch (error) {
    processLogger.warn(
      { err: loggableThrown(error), key: SAFE_MODE_ATTENTION_KEY },
      "Could not update the safe-mode attention item",
    );
  }
}

/**
 * Ends safe mode in this process and loads the installed integrations. The
 * file goes first, so a restart in the middle no longer starts in safe mode.
 * Safe mode the environment forces cannot be left here.
 */
export async function leaveSafeMode(): Promise<SafeModeState> {
  if (state.reason === "env") throw new SafeModeForcedError();
  if (!state.active) return getSafeMode();
  const reload = host?.reload;
  if (!reload) throw new Error("The integration host is not running");
  rmSync(join(runtimeDirectory, SAFE_MODE_FILE), { force: true });
  // The unclean exits counted so far led to the safe mode being left; they
  // must not turn it on again at the next start.
  clearUncleanExits(runtimeDirectory);
  state = { ...INACTIVE };
  try {
    await resolveAttention(SAFE_MODE_ATTENTION_KEY);
  } catch (error) {
    processLogger.warn(
      { err: loggableThrown(error), key: SAFE_MODE_ATTENTION_KEY },
      "Could not resolve the safe-mode attention item",
    );
  }
  try {
    await reload();
  } catch (error) {
    // The registry still holds the records safe mode held back; without
    // this they would read as held back by a safe mode that is no longer on.
    host?.reloadFailed(describeThrown(error));
    throw error;
  }
  return getSafeMode();
}
