import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readDataManagerNdjson } from "./stream-decoder";

const events = z.discriminatedUnion("event", [
  z.object({ event: z.literal("progress"), message: z.string() }),
  z.object({ event: z.literal("done"), ok: z.boolean() }),
  z.object({ event: z.literal("error"), message: z.string() }),
]);
const response = (text: string) =>
  new Response(text, { headers: { "content-type": "application/x-ndjson" } });
describe("data-manager strict NDJSON decoder", () => {
  it("preserves split UTF8 progress, whitespace heartbeats and domain unsuccessful done", async () => {
    const bytes = new TextEncoder().encode(
      '  \n{"event":"progress","message":"街"}\n{"event":"done","ok":false}\n',
    );
    const input = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );
    const messages: string[] = [];
    expect(
      await readDataManagerNdjson(input, events, (event) => messages.push(event.message)),
    ).toEqual({ event: "done", ok: false });
    expect(messages).toEqual(["街"]);
    expect(input.body?.locked).toBe(false);
  });
  it.each([
    "nonsense\n",
    "{}\n",
    '{"event":"done"}\n',
    '{"event":"done","ok":true}\n{"event":"done","ok":true}\n',
    '{"event":"done","ok":true}\n{"event":"progress","message":"late"}\n',
  ])("rejects malformed and conflicting terminal sequences", async (text) => {
    await expect(readDataManagerNdjson(response(text), events)).rejects.toThrow();
  });
  it("requires terminal completion", async () => {
    await expect(readDataManagerNdjson(response(" \n"), events)).rejects.toThrow(/done/);
  });
  it("cancels and releases readers on byte limits, idle deadlines and caller abort", async () => {
    for (const kind of ["limit", "idle", "abort"]) {
      let canceled = false;
      const control = new AbortController();
      const input = new Response(
        new ReadableStream({
          start(controller) {
            if (kind === "limit") controller.enqueue(new TextEncoder().encode("123456789"));
          },
          cancel() {
            canceled = true;
          },
        }),
      );
      const pending = readDataManagerNdjson(input, events, undefined, {
        maxBytes: 4,
        idleTimeoutMs: 5,
        signal: control.signal,
      });
      if (kind === "abort") control.abort(new Error("canceled"));
      await expect(pending).rejects.toThrow();
      expect(canceled).toBe(true);
      expect(input.body?.locked).toBe(false);
    }
  });
  it("rejects non-finite caller limits without abandoning its reader", async () => {
    const input = response('{"event":"done","ok":true}');
    await expect(
      readDataManagerNdjson(input, events, undefined, { maxBytes: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/limits/);
    expect(input.body?.locked).toBe(false);
  });
});
