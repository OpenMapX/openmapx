import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ExpoLocationDriver } from "../location/ExpoLocationDriver";
import type { LocationPermissionState } from "../location/LocationDriver";
import { type LocationProfileKind, profileFor } from "../location/profiles";
import { getDatabase } from "../storage/database";
import {
  EMPTY_PROBE_STATE,
  type FeasibilityProbeState,
  FeasibilityRepository,
} from "../storage/feasibilityRepository";
import { deviceMobileLocale } from "./shellCopy";

/**
 * Developer-only probe surface.
 *
 * This exists to answer one question during the feasibility phase: does a
 * globally-registered TaskManager callback keep committing to SQLite while the
 * app is backgrounded? It shows counters and buckets — never a coordinate — and
 * is compiled out of any build that was not made with
 * `OPENMAPX_MOBILE_FEASIBILITY_MODE=1`.
 *
 * It is not localised and never will be: it is not part of the product.
 */

const styles = StyleSheet.create({
  panel: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 24,
    maxHeight: 320,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(16,20,24,0.92)",
  },
  heading: { color: "#FFFFFF", fontSize: 14, fontWeight: "700", marginBottom: 6 },
  line: { color: "#D7DDE3", fontSize: 13, lineHeight: 18 },
  disclosure: { color: "#FFD79A", fontSize: 12, lineHeight: 17, marginVertical: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  button: {
    minHeight: 44,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: "#1B69D6",
  },
  buttonLabel: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
});

const PROFILE_CYCLE: LocationProfileKind[] = ["driving", "walking", "transit-cruise"];

/**
 * The prominent explanation shown before any background permission request.
 * The production flow has its own fully localised version; this developer
 * build must still never reach an OS prompt without stating the purpose.
 */
const BACKGROUND_DISCLOSURE =
  "This developer probe collects your precise location in the background to verify that " +
  "guidance keeps running while the screen is locked. Only counters and accuracy buckets " +
  "are stored — never coordinates. Tracking stops when you press End.";

export function FeasibilityOverlay(): ReactElement {
  const locale = useMemo(() => deviceMobileLocale(), []);
  const driver = useMemo(() => new ExpoLocationDriver(locale), [locale]);
  const [permission, setPermission] = useState<LocationPermissionState>("not-determined");
  const [running, setRunning] = useState(false);
  const [profileIndex, setProfileIndex] = useState(0);
  const [state, setState] = useState<FeasibilityProbeState>(EMPTY_PROBE_STATE);
  const [disclosureAccepted, setDisclosureAccepted] = useState(false);
  const [lastAction, setLastAction] = useState<string>("idle");

  const repository = useCallback(async () => new FeasibilityRepository(await getDatabase()), []);

  const refresh = useCallback(async () => {
    setState(await (await repository()).read());
    setRunning(await driver.isRunning());
    setPermission(await driver.getPermissionState());
  }, [driver, repository]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const start = useCallback(async () => {
    try {
      if (!disclosureAccepted) {
        setDisclosureAccepted(true);
        setLastAction("read the disclosure, then press Start again");
        return;
      }
      // Android 14+ requires a location foreground service to be started while
      // the app is visible, so the probe refuses to start otherwise.
      if (AppState.currentState !== "active") {
        setLastAction("start refused: app is not in the foreground");
        return;
      }
      const foreground = await driver.requestForegroundPermission();
      if (foreground === "denied" || foreground === "not-determined") {
        setLastAction(`foreground permission: ${foreground}`);
        await refresh();
        return;
      }
      const background = await driver.requestBackgroundPermission();
      setLastAction(`permission: ${background}`);
      await driver.start(profileFor(PROFILE_CYCLE[profileIndex]));
      setLastAction(`started (${PROFILE_CYCLE[profileIndex]})`);
    } catch (error) {
      setLastAction(`start failed: ${(error as Error).name}`);
    } finally {
      await refresh();
    }
  }, [disclosureAccepted, driver, profileIndex, refresh]);

  const end = useCallback(async () => {
    try {
      await driver.stop();
      // Verifying rather than assuming: a stop that leaves the stream running is
      // exactly the teardown failure this probe is meant to catch.
      setLastAction((await driver.isRunning()) ? "END FAILED: still running" : "ended");
    } catch (error) {
      setLastAction(`stop failed: ${(error as Error).name}`);
    } finally {
      await refresh();
    }
  }, [driver, refresh]);

  const switchProfile = useCallback(async () => {
    const next = (profileIndex + 1) % PROFILE_CYCLE.length;
    setProfileIndex(next);
    if (await driver.isRunning()) await driver.start(profileFor(PROFILE_CYCLE[next]));
    setLastAction(`profile: ${PROFILE_CYCLE[next]}`);
    await refresh();
  }, [driver, profileIndex, refresh]);

  const armAudioProbe = useCallback(async () => {
    await (await repository()).commit((current) => ({
      ...current,
      pendingAudioProbe: true,
      updatedAtMs: Date.now(),
    }));
    setLastAction("audio probe armed for the next accepted callback");
    await refresh();
  }, [refresh, repository]);

  return (
    <View style={styles.panel} testID="feasibility-overlay">
      <Text style={styles.heading}>Feasibility probe (developer build)</Text>
      <ScrollView>
        <Text style={styles.line}>permission: {permission}</Text>
        <Text style={styles.line}>stream running: {String(running)}</Text>
        <Text style={styles.line}>profile: {PROFILE_CYCLE[profileIndex]}</Text>
        <Text style={styles.line}>callbacks: {state.callbackCount}</Text>
        <Text style={styles.line}>
          fixes accepted/rejected: {state.acceptedFixCount}/{state.rejectedFixCount}
        </Text>
        <Text style={styles.line}>last accuracy bucket: {state.lastAccuracyBucket ?? "—"}</Text>
        <Text style={styles.line}>last callback gap: {state.lastCallbackGapMs ?? "—"} ms</Text>
        <Text style={styles.line}>max callback gap: {state.maxCallbackGapMs ?? "—"} ms</Text>
        <Text style={styles.line}>audio result: {state.audioResultCode ?? "—"}</Text>
        <Text style={styles.line}>last error: {state.lastErrorCode ?? "—"}</Text>
        <Text style={styles.line}>last action: {lastAction}</Text>
        {disclosureAccepted ? null : <Text style={styles.disclosure}>{BACKGROUND_DISCLOSURE}</Text>}
      </ScrollView>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          onPress={() => void start()}
          style={styles.button}
          testID="feasibility-start"
        >
          <Text style={styles.buttonLabel}>Start</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void end()}
          style={styles.button}
          testID="feasibility-end"
        >
          <Text style={styles.buttonLabel}>End</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void switchProfile()}
          style={styles.button}
          testID="feasibility-profile"
        >
          <Text style={styles.buttonLabel}>Profile</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void armAudioProbe()}
          style={styles.button}
          testID="feasibility-arm-audio"
        >
          <Text style={styles.buttonLabel}>Arm audio</Text>
        </Pressable>
      </View>
    </View>
  );
}
