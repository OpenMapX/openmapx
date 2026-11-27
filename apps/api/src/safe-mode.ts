import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isComponentId } from "@openmapx/core/component-id";
import { describeThrown, loggableThrown } from "@openmapx/integration-framework";
import { processLogger } from "./process-logger";
import { raiseAttention, resolveAttention } from "./services/attention";

/**
 * Whether installed integrations are kept out of this process, and why:
 * `env` when `OPENMAPX_SAFE_MODE=1` forces it, `operator` when an operator
 * turned it on, `automatic` when the API stopped repeatedly while starting,
 * with the integration it was loading when that is known.
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
    return `The API stopped repeatedly while ${integrationName(current.integrationId)} (${current.integrationId}) was loading, so no installed extension is loaded. Disable or update that extension, then leave safe mode.`;
  if (current.reason === "automatic")
    return "OpenMapX stopped repeatedly while starting, so installed extensions were not loaded. Find the extension that stops it in the API log, disable or update it, then leave safe mode.";
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
    if (state.active)
      await raiseAttention({
        key: SAFE_MODE_ATTENTION_KEY,
        severity: "warning",
        source: "safe-mode",
        title: "Safe mode is on",
        detail: attentionDetail(state),
        action: { label: "Leave safe mode", href: "/admin/integrations" },
      });
    else await resolveAttention(SAFE_MODE_ATTENTION_KEY);
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
  rmSync(join(runtimeDirectory, BOOT_MARKER_FILE), { force: true });
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
