import { describe, expect, it } from "vitest";
import {
  asJobLogger,
  asPoiJobLogger,
  createRootLogger,
  jobChildLogger,
  withPoiBindings,
} from "../src/logger.js";

function makeSink() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: {
      write(msg: string) {
        lines.push(JSON.parse(msg));
      },
    },
  };
}

describe("data-manager logger", () => {
  it("binds job and jobId on child logger lines", () => {
    const sink = makeSink();
    const base = createRootLogger(sink.stream);
    const child = jobChildLogger({ job: "transitous-sync", jobId: "j-1" }, base);
    asJobLogger(child).info("stage done");
    expect(sink.lines[0]).toMatchObject({
      job: "transitous-sync",
      jobId: "j-1",
      msg: "stage done",
    });
  });

  it("passes PoiJobLogger extras as pino merge objects", () => {
    const sink = makeSink();
    const base = createRootLogger(sink.stream);
    asPoiJobLogger(jobChildLogger({ job: "poi-ingest" }, base)).warn("swap skipped", { rows: 12 });
    expect(sink.lines[0]).toMatchObject({ job: "poi-ingest", rows: 12, msg: "swap skipped" });
  });

  it("withPoiBindings stamps bindings into every extra", () => {
    const sink = makeSink();
    const base = createRootLogger(sink.stream);
    const inner = asPoiJobLogger(base);
    withPoiBindings(inner, { jobId: "j-2" }).error("boom", { stage: "fetch" });
    expect(sink.lines[0]).toMatchObject({ jobId: "j-2", stage: "fetch", msg: "boom" });
  });
});
