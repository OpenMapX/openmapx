import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataManagerJobStages } from "../DataManagerJobStages";

describe("DataManagerJobStages", () => {
  it("renders structured stage errors safely and formats durations", () => {
    const html = renderToStaticMarkup(
      <DataManagerJobStages
        stages={[
          {
            id: "stage-1",
            stage: "motis-import",
            status: "error",
            durationMs: 61_250,
            message: "Import failed",
            error: { message: "Transactional import failed", stack: "long stack" },
          },
        ]}
      />,
    );

    expect(html).toContain("motis import");
    expect(html).toContain("Transactional import failed");
    expect(html).toContain("1m 1s");
    expect(html).not.toContain("long stack");
  });

  it("uses a context-specific empty state", () => {
    const html = renderToStaticMarkup(
      <DataManagerJobStages stages={[]} emptyMessage="Waiting for the first stage..." />,
    );

    expect(html).toContain("Stages (0)");
    expect(html).toContain("Waiting for the first stage...");
  });
});
