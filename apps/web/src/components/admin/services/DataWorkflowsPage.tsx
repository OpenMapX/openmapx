"use client";
// Compatibility for existing focused inventory consumers; canonical routes use DataWorkspace.
import { DataWorkspace } from "../data/DataWorkspace";
export function DataWorkflowsPage() {
  return <DataWorkspace topic="osm" />;
}
