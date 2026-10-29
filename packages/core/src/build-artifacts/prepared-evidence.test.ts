import { expect, it } from "vitest";
import { incompletePreparedLayout, verifyPreparedMotisManifest } from "./prepared-evidence";

it("requires every recorded MOTIS source artifact to match the actual candidate manifest", () => {
  const artifact = (path: string) => ({ path, sizeBytes: 3, sha256: "a".repeat(64) }),
    artifacts = {
      config: artifact("config.yml"),
      license: artifact("license.json"),
      proxyConfig: artifact(".openmapx-feed-proxy/default.conf"),
      proxyVars: artifact(".openmapx-feed-proxy/vars.json"),
      sourceManifest: artifact("transit-source-manifest.json"),
      datasets: [artifact("gtfs.zip")],
    };
  const manifest = { schemaVersion: 1, epoch: "candidate-epoch", artifacts };
  const { datasets, ...fixed } = artifacts;
  const files = [...Object.values(fixed), ...datasets].map((value) => ({
    ...value,
    path: `motis/live/${value.path}`,
  }));
  expect(verifyPreparedMotisManifest(manifest, files)).toBe(true);
  expect(
    verifyPreparedMotisManifest(
      manifest,
      files.map((file, index) => (index === 0 ? { ...file, sha256: "b".repeat(64) } : file)),
    ),
  ).toBe(false);
  expect(
    verifyPreparedMotisManifest(
      { ...manifest, artifacts: { ...artifacts, datasets: [artifact("../outside")] } },
      files,
    ),
  ).toBe(false);
  expect(verifyPreparedMotisManifest({ schemaVersion: 1, epoch: "incomplete" }, files)).toBe(false);
});
it("requires concrete runtime companions instead of nonempty directories", () => {
  expect(
    incompletePreparedLayout("osrm", [{ path: "osrm-graph/region.osrm", sizeBytes: 3 }]),
  ).toMatch(/companions/);
  expect(incompletePreparedLayout("otp", [{ path: "otp-graph/input.pbf", sizeBytes: 3 }])).toMatch(
    /graph.obj/,
  );
  expect(
    incompletePreparedLayout("tileserver", [{ path: "tile-mbtiles/tiles.mbtiles", sizeBytes: 0 }]),
  ).toMatch(/MBTiles/);
  expect(
    incompletePreparedLayout("motis", [
      { path: "motis/live/motis-candidate-manifest.json", sizeBytes: 20 },
    ]),
  ).toMatch(/imported data/);
});
