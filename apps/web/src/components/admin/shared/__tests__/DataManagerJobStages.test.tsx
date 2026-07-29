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
            artifacts: null,
          },
        ]}
      />,
    );

    expect(html).toContain("motis import");
    expect(html).toContain("Transactional import failed");
    expect(html).toContain("1m 1s");
    expect(html).not.toContain("long stack");
  });

  it("explains which validation archives caused a partial result", () => {
    const html = renderToStaticMarkup(
      <DataManagerJobStages
        stages={[
          {
            id: "stage-validate",
            stage: "validate",
            status: "partial",
            durationMs: 171,
            message: "Validated 4 / 6 archive(s); 2 invalid",
            error: null,
            artifacts: {
              invalid: [
                { id: "de_VBB", reason: "missing feed_info.txt" },
                { id: "de_VBN", reason: "missing feed_info.txt" },
              ],
            },
          },
        ]}
      />,
    );

    expect(html).toContain("Invalid archives");
    expect(html).toContain("de_VBB: missing feed_info.txt");
    expect(html).toContain("de_VBN: missing feed_info.txt");
  });

  it("uses a context-specific empty state", () => {
    const html = renderToStaticMarkup(
      <DataManagerJobStages stages={[]} emptyMessage="Waiting for the first stage..." />,
    );

    expect(html).toContain("Stages (0)");
    expect(html).toContain("Waiting for the first stage...");
  });
});
