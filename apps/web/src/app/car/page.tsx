"use client";
import { setNavigationAuthority, useNavigationStore, useSettingsStore } from "@openmapx/core";
import type {
  CarNativeToWebMessage,
  CarPosition,
  CarPreview,
  CarViewport,
  CarWebToNativeMessage,
} from "@openmapx/core/navigation";
import { NextIntlClientProvider, useMessages } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { MapProvider, useMap } from "@/integration-api/map/MapContext";
import { EnvProvider, useEnv } from "@/integration-api/runtime/EnvProvider";
import { IntegrationProvider } from "@/providers/IntegrationProvider";
import { CarMap } from "./CarMap";
import {
  applyCarCamera,
  attachCarHost,
  type CarHost,
  createCarSnapshotReceiver,
} from "./carSurface";

declare global {
  interface Window {
    OpenMapXCar?: CarHost;
  }
}
const initialViewport: CarViewport = {
  v: 1,
  type: "car-viewport",
  width: 800,
  height: 480,
  stable: { top: 0, right: 0, bottom: 0, left: 0 },
  visible: { top: 0, right: 0, bottom: 0, left: 0 },
  dark: false,
};

function Surface({ host, harness }: { host?: CarHost; harness: boolean }) {
  const [viewport, setViewport] = useState(initialViewport);
  const [preview, setPreview] = useState<CarPreview | null>(null);
  const [position, setPosition] = useState<CarPosition | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const [locale, setLocale] = useState<"en" | "de">("en");
  const [units, setUnits] = useState<"metric" | "imperial">("metric");
  const messages = useMessages();
  const { mapRef } = useMap();
  const send = useCallback(
    (message: CarWebToNativeMessage) => host?.postMessage(JSON.stringify(message)),
    [host],
  );
  const error = useCallback((code: string) => send({ v: 1, type: "car-error", code }), [send]);
  const snapshot = useRef(createCarSnapshotReceiver(error));
  const receive = useCallback(
    (message: CarNativeToWebMessage) => {
      switch (message.type) {
        case "car-hello":
          setLocale(message.locale);
          setUnits(message.units);
          useSettingsStore.setState({ units: message.units, mapNorthUp: false });
          setViewport((v) => ({ ...v, dark: message.dark }));
          break;
        case "car-viewport":
          setViewport(message);
          break;
        case "car-preview":
          setPreview(message);
          useNavigationStore
            .getState()
            .setCameraMode(message.routes.length ? "overview" : "follow");
          break;
        case "car-camera":
          applyCarCamera(mapRef.current, message, viewportRef.current.stable);
          break;
        case "car-position":
          setPosition(message);
          break;
        case "car-snapshot":
          // A trip that starts after a preview drives in follow mode, not the preview's overview.
          if (previewRef.current?.routes.length)
            useNavigationStore.getState().setCameraMode("follow");
          setPreview(null);
          snapshot.current(message.message);
          break;
      }
    },
    [mapRef],
  );
  useEffect(() => {
    setNavigationAuthority("native");
    const detach = attachCarHost(host, receive);
    send({
      v: 1,
      type: "car-map-state",
      following: useNavigationStore.getState().cameraMode === "follow",
    });
    const unsubscribe = useNavigationStore.subscribe((state, previous) => {
      if (state.cameraMode !== previous.cameraMode)
        send({ v: 1, type: "car-map-state", following: state.cameraMode === "follow" });
    });
    return () => {
      detach();
      unsubscribe();
    };
  }, [host, receive, send]);
  useEffect(() => {
    if (process.env.NODE_ENV !== "development" || !harness) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void import("./harness").then(({ startHarness }) => {
      if (!cancelled) cleanup = startHarness(receive);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [harness, receive]);
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div
        data-car-surface
        style={{
          position: "fixed",
          inset: 0,
          width: viewport.width,
          height: viewport.height,
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        <IntegrationProvider publicOnly>
          <CarMap
            viewport={viewport}
            preview={preview}
            position={position}
            units={units}
            error={error}
          />
        </IntegrationProvider>
      </div>
    </NextIntlClientProvider>
  );
}
export default function CarPage() {
  const env = useEnv();
  const [environment, setEnvironment] = useState<{ host?: CarHost; harness: boolean } | null>(null);
  useEffect(() => {
    setEnvironment({
      host: window.OpenMapXCar,
      harness:
        process.env.NODE_ENV === "development" &&
        new URLSearchParams(location.search).get("carPreview") === "1",
    });
  }, []);
  if (!environment || (!environment.host && !environment.harness))
    return <main style={{ padding: 32 }}>OpenMapX car surface · waiting for the car host</main>;
  const config =
    process.env.NODE_ENV === "development" && environment.harness
      ? {
          ...env,
          apiUrl: "https://openmapx.com",
          tilesUrl: "https://openmapx.com/tiles/data/openmapx.json",
          mapStyleUrl: "https://openmapx.com/tiles",
          martinBaseUrl: "https://openmapx.com/martin",
        }
      : env;
  return (
    <EnvProvider config={config}>
      <MapProvider>
        <Surface {...environment} />
      </MapProvider>
    </EnvProvider>
  );
}
