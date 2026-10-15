"use client";

import {
  contributorsForRecordFields,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { LiveTransitVehicle } from "@openmapx/mobility-core/transit";
import { AttributionStrip } from "@/integration-api/components/AttributionStrip";
import type { LiveTransitSnapshot } from "./types";

export interface ParsedVehicle extends LiveTransitVehicle {
  speedKmh: number | null;
  color: string;
  alerts: LiveTransitSnapshot["alerts"];
}

const severityColor = {
  critical: "#B91C1C",
  severe: "#DC2626",
  warning: "#D97706",
  info: "#2563EB",
};

/** A mounted popup owns only the vehicle fields and two alert summaries it displays. */
export function LiveTransitPopup({ vehicle }: { vehicle: ParsedVehicle }) {
  const alerts = vehicle.alerts.slice(0, 2);
  const attributions = snapshotContributors(
    contributorsForRecordFields(vehicle, [
      "displayLabel",
      "updatedAt",
      "mode",
      ...(vehicle.positionKind === "interpolated" ? ["positionKind"] : []),
      ...(vehicle.secondaryLabel ? ["secondaryLabel"] : []),
      ...(vehicle.codespaceId ? ["codespaceId"] : []),
      ...(vehicle.speedKmh != null && vehicle.speedKmh > 0 ? ["speed"] : []),
    ]),
    ...alerts.map((alert) => contributorsForRecordFields(alert, ["title", "severity"])),
  );
  return (
    <div style={{ fontFamily: "'Plus Jakarta Sans',Arial,sans-serif", minWidth: 210 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: vehicle.color,
            color: "#fff",
            fontWeight: 700,
            fontSize: 14,
            borderRadius: 6,
            minWidth: 48,
            height: 32,
            padding: "0 10px",
          }}
        >
          {vehicle.displayLabel}
        </span>
      </div>
      {vehicle.secondaryLabel && (
        <div style={{ fontSize: 12, color: "#4b5563" }}>{vehicle.secondaryLabel}</div>
      )}
      {vehicle.codespaceId && (
        <div style={{ fontSize: 12, color: "#4b5563" }}>Codespace {vehicle.codespaceId}</div>
      )}
      {vehicle.speedKmh != null && vehicle.speedKmh > 0 && (
        <div style={{ fontSize: 12, color: "#4b5563" }}>{vehicle.speedKmh} km/h</div>
      )}
      <div style={{ fontSize: 11, color: "#6b7280" }}>
        Updated{" "}
        {new Date(vehicle.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </div>
      {vehicle.positionKind === "interpolated" && (
        <div style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>
          Estimated position
        </div>
      )}
      {alerts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
          {alerts.map((alert) => (
            <div
              key={alert.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "#374151",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: severityColor[alert.severity],
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 10,
                  borderRadius: 999,
                  minWidth: 20,
                  height: 20,
                  padding: "0 6px",
                }}
              >
                {alert.severity.toUpperCase()}
              </span>
              <span>{alert.title}</span>
            </div>
          ))}
        </div>
      )}
      <div
        style={{
          fontSize: 11,
          color: "#6b7280",
          borderTop: "1px solid #e5e7eb",
          paddingTop: 6,
          marginTop: 8,
        }}
      >
        <AttributionStrip attributions={attributions} provenanceDisplay="details" />
      </div>
    </div>
  );
}
