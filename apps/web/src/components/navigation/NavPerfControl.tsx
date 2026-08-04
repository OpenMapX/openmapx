"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useNavigationStore } from "@openmapx/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMapOptional } from "@/lib/MapContext";
import {
  createNavigationPerfMonitor,
  NAV_PERF_SCENARIOS,
  type NavigationPerfMonitor,
  type NavPerfMetadata,
  type NavPerfSnapshot,
} from "@/lib/navigation/navigationPerfMonitor";

/** How often the HUD re-reads the aggregates. Deliberately slow: the instrument must not become the load. */
const READOUT_INTERVAL_MS = 1000;

const META_FIELDS = [
  { key: "deviceModel", testId: "nav-perf-meta-device", label: "device" },
  { key: "browserVersion", testId: "nav-perf-meta-browser", label: "browser" },
  { key: "buildSha", testId: "nav-perf-meta-build", label: "build sha" },
  { key: "brightnessPercent", testId: "nav-perf-meta-brightness", label: "brightness %" },
  { key: "networkType", testId: "nav-perf-meta-network", label: "network" },
] as const satisfies ReadonlyArray<{
  key: keyof NavPerfMetadata;
  testId: string;
  label: string;
}>;

const emptyMetadata = (): NavPerfMetadata => ({
  deviceModel: "",
  browserVersion: "",
  buildSha: "",
  brightnessPercent: "",
  networkType: "",
  scenario: "",
});

const kb = (bytes: number) => Math.round(bytes / 1024);

/**
 * Floating QA HUD for a navigation performance run, opt-in via `?navperf=1`.
 *
 * Deliberately inert unless that flag is present: without it this component
 * renders null and — more importantly — attaches no map listener, performance
 * observer, interval or animation frame, so it cannot influence the very
 * behaviour it exists to measure. Even with the flag, measurement begins only on
 * an explicit start click and the export is only ever produced by a click, so a
 * normal session never writes a file.
 *
 * The readout refreshes once per second rather than per frame: a HUD that
 * re-rendered on every sample would be measuring itself. Sibling of
 * {@link NavSimControl}, and intentionally styled like it — this is a QA
 * instrument, not a user feature.
 */
export function NavPerfControl() {
  const mapCtx = useMapOptional();
  // Read the flag once on mount, mirroring how the simulator opts in. Nothing
  // below this component's early return is allowed to allocate when it is off.
  const [enabled] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("navperf") === "1",
  );
  const monitorRef = useRef<NavigationPerfMonitor | null>(null);
  const [running, setRunning] = useState(false);
  const [snapshot, setSnapshot] = useState<NavPerfSnapshot | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [metadata, setMetadata] = useState<NavPerfMetadata>(emptyMetadata);

  useEffect(() => {
    if (!enabled || !running) return;
    const id = setInterval(() => {
      setSnapshot(monitorRef.current?.snapshot() ?? null);
    }, READOUT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, running]);

  // A run must never outlive the overlay: leaving navigation has to release the
  // frame loop, observers and map listeners.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      monitorRef.current?.stop();
      monitorRef.current = null;
    };
  }, [enabled]);

  const applyMetadata = useCallback((next: NavPerfMetadata) => {
    setMetadata(next);
    monitorRef.current?.setMetadata(next);
  }, []);

  const toggleRun = useCallback(() => {
    const monitor = monitorRef.current ?? createNavigationPerfMonitor();
    monitorRef.current = monitor;
    if (running) {
      monitor.stop();
      setRunning(false);
    } else {
      monitor.setMetadata(metadata);
      monitor.start(mapCtx?.mapRef.current ?? null, useNavigationStore);
      setRunning(true);
    }
    setSnapshot(monitor.snapshot());
  }, [mapCtx, metadata, running]);

  const resetRun = useCallback(() => {
    monitorRef.current?.reset();
    setSnapshot(monitorRef.current?.snapshot() ?? null);
  }, []);

  // Export is explicit and one-shot: the aggregates are written to a file the
  // tester attaches to the run's notes, never uploaded anywhere.
  const exportRun = useCallback(() => {
    const current = monitorRef.current?.snapshot();
    if (!current) return;
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "navperf-run.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const lines = useMemo(() => {
    const s = snapshot;
    const res = s?.resources;
    return {
      frames: s
        ? `fps ${s.frames.estimatedFps} · p95 ${s.frames.p95Ms}ms · >32 ${s.frames.over32ms} · >50 ${s.frames.over50ms}`
        : "fps —",
      longTasks: s?.longTasks.supported
        ? `long tasks ${s.longTasks.count} · ${Math.round(s.longTasks.totalMs)}ms · max ${Math.round(s.longTasks.longestMs)}ms`
        : "long tasks n/a",
      map: s
        ? `map r${s.map.render} mv${s.map.move} me${s.map.moveend} id${s.map.idle}`
        : "map r0 mv0 me0 id0",
      progress: s
        ? `progress ${s.navigation.progressPublications} of ${s.navigation.storeNotifications}`
        : "progress 0 of 0",
      net: res
        ? `net t${res.tile.count} c${res["road-conditions"].count} r${res.routing.count} o${res.other.count} · ${kb(
            res.tile.transferBytes +
              res["road-conditions"].transferBytes +
              res.routing.transferBytes +
              res.other.transferBytes,
          )}kB`
        : "net —",
      elapsed: s ? `${Math.round(s.elapsedMs / 1000)}s` : "0s",
    };
  }, [snapshot]);

  if (!enabled) return null;

  return (
    <Box
      data-testid="nav-perf-control"
      sx={{
        pointerEvents: "auto",
        position: "fixed",
        top: "calc(var(--omx-safe-top) + 96px)",
        left: 8,
        zIndex: 1400,
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        p: 1,
        bgcolor: "rgba(0,0,0,0.78)",
        color: "#fff",
        borderRadius: 2,
        maxWidth: 220,
      }}
    >
      <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.5 }}>
        NAV PERF · {lines.elapsed}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        <Chip
          data-testid="nav-perf-start"
          label={running ? "stop" : "start"}
          size="small"
          color={running ? "error" : "primary"}
          onClick={toggleRun}
        />
        <Chip data-testid="nav-perf-reset" label="reset" size="small" onClick={resetRun} />
        <Chip data-testid="nav-perf-export" label="export" size="small" onClick={exportRun} />
        <Chip
          data-testid="nav-perf-meta-toggle"
          label="meta"
          size="small"
          color={metaOpen ? "primary" : "default"}
          onClick={() => setMetaOpen((o) => !o)}
        />
      </Box>
      <Typography data-testid="nav-perf-frames" variant="caption">
        {lines.frames}
      </Typography>
      <Typography data-testid="nav-perf-longtasks" variant="caption">
        {lines.longTasks}
      </Typography>
      <Typography data-testid="nav-perf-map" variant="caption">
        {lines.map}
      </Typography>
      <Typography data-testid="nav-perf-progress" variant="caption">
        {lines.progress}
      </Typography>
      <Typography data-testid="nav-perf-net" variant="caption">
        {lines.net}
      </Typography>
      {metaOpen && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, mt: 0.5 }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
            {NAV_PERF_SCENARIOS.map((scenario) => (
              <Chip
                key={scenario.key}
                data-testid={`nav-perf-scenario-${scenario.key}`}
                label={scenario.key}
                size="small"
                color={metadata.scenario === scenario.key ? "primary" : "default"}
                onClick={() => applyMetadata({ ...metadata, scenario: scenario.key })}
              />
            ))}
          </Box>
          {META_FIELDS.map((field) => (
            <TextField
              key={field.key}
              data-testid={field.testId}
              label={field.label}
              value={metadata[field.key]}
              size="small"
              variant="standard"
              onChange={(e) => applyMetadata({ ...metadata, [field.key]: e.target.value })}
              slotProps={{
                inputLabel: { sx: { color: "rgba(255,255,255,0.7)" } },
                input: { sx: { color: "#fff", fontSize: 12 } },
              }}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
