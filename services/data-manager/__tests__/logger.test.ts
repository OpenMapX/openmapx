import Fastify from "fastify";
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
  it("scrubs secrets from messages, nested fields, errors, and child bindings without mutation", () => {
    const sink = makeSink();
    const base = createRootLogger(sink.stream);
    base.level = "debug";
    const error = new Error(
      "request https://error-user:ERROR-PASSWORD@feeds.example.org/data?token=ERROR-TOKEN failed",
    );
    const details = {
      endpoint: "https://field-user:FIELD-PASSWORD@feeds.example.org/data?key=FIELD-TOKEN#debug",
      nested: { authorization: "Bearer NESTED-BEARER-TOKEN" },
      credentials: {
        password: "BARE-PASSWORD-VALUE",
        apiKey: "BARE-API-KEY-VALUE",
      },
      err: error,
    };
    const child = base.child({
      callbackUrl: "https://child-user:CHILD-PASSWORD@feeds.example.org/hook?secret=CHILD-TOKEN",
    });

    child.debug(details, "retry with api-key=MESSAGE-TOKEN");

    const serialized = JSON.stringify(sink.lines[0]);
    for (const secret of [
      "ERROR-PASSWORD",
      "ERROR-TOKEN",
      "FIELD-PASSWORD",
      "FIELD-TOKEN",
      "NESTED-BEARER-TOKEN",
      "BARE-PASSWORD-VALUE",
      "BARE-API-KEY-VALUE",
      "CHILD-PASSWORD",
      "CHILD-TOKEN",
      "MESSAGE-TOKEN",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("feeds.example.org");
    expect(serialized).toContain("[redacted]");
    expect(details.endpoint).toContain("FIELD-TOKEN");
    expect(error.message).toContain("ERROR-TOKEN");
  });

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

  it("scrubs credentials from Fastify request logs after request serialization", async () => {
    const sink = makeSink();
    const app = Fastify({ loggerInstance: createRootLogger(sink.stream) });
    app.get("/probe", async () => ({ ok: true }));

    await app.inject({
      method: "GET",
      url: "/probe?token=FASTIFY-QUERY-TOKEN",
      headers: { authorization: "Bearer FASTIFY-AUTH-TOKEN" },
    });
    await app.close();

    const serialized = JSON.stringify(sink.lines);
    expect(serialized).not.toMatch(/FASTIFY-QUERY-TOKEN|FASTIFY-AUTH-TOKEN/);
    expect(serialized).toContain("/probe");
  });

  it("scrubs one-use operator relay handles from Fastify request logs", async () => {
    const sink = makeSink();
    const app = Fastify({ loggerInstance: createRootLogger(sink.stream) });
    app.get("/internal/transit/operator-feed/:handle", async () => ({ ok: true }));
    const handle = "a".repeat(64);

    await app.inject({
      method: "GET",
      url: `/internal/transit/operator-feed/${handle}`,
    });
    await app.close();

    const serialized = JSON.stringify(sink.lines);
    expect(serialized).not.toContain(handle);
    expect(serialized).toContain("/internal/transit/operator-feed/[redacted]");
  });
});
