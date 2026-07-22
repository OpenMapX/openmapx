"use client";

// The coverage layer is shared by every street-level-imagery provider and renders all
// of them at once; `sharedMapLayer` in the manifest ensures it mounts once.
export { StreetLevelCoverageLayer as default } from "@/components/map/street-level-imagery/StreetLevelCoverageLayer";
