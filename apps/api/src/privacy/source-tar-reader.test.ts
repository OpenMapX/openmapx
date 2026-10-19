import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { changeTarHeader, tar, tarMember } from "./__tests__/fixtures/source-tar.js";
import { SOURCE_TAR_LIMITS, type SourceTarLimits, SourceTarReader } from "./source-tar-reader.js";

function reader(input: AsyncIterable<Uint8Array>, limits: SourceTarLimits = SOURCE_TAR_LIMITS) {
  return new SourceTarReader(input, limits, (code) => Object.assign(new Error(code), { code }));
}
async function drain({ content }: { content: AsyncIterable<Uint8Array> }) {
  for await (const _chunk of content) {
    /* Consume each member before advancing. */
  }
}
async function* chunks(input: Buffer, size = 7) {
  for (let start = 0; start < input.length; start += size)
    yield input.subarray(start, start + size);
}
const small = { maxEntries: 2, maxEntryBytes: 4, maxTotalBytes: 8 };

describe("privacy source TAR framing", () => {
  it("reads fragmented headers, zero-size and block-aligned bodies without losing framing", async () => {
    const seen: Array<[string, number]> = [];
    await reader(
      chunks(
        tar([
          ["empty", Buffer.alloc(0)],
          ["aligned", Buffer.alloc(512)],
        ]),
      ),
    ).read(async (entry) => {
      let bytes = 0;
      for await (const chunk of entry.content) bytes += chunk.length;
      seen.push([entry.path, bytes]);
    });
    expect(seen).toEqual([
      ["empty", 0],
      ["aligned", 512],
    ]);
  });

  it("accepts regular NUL type and USTAR prefixes", async () => {
    const input = changeTarHeader(tar([["member", Buffer.from("x")]]), (header) => {
      header[156] = 0;
      header.write("source", 345);
    });
    const names: string[] = [];
    await reader(chunks(input)).read(async (entry) => {
      names.push(entry.path);
      await drain(entry);
    });
    expect(names).toEqual(["source/member"]);
  });

  it.each(["/absolute", "a/../b", "a/./b", "a//b", "a\\b", ""])(
    "rejects unsafe path %s",
    async (path) => {
      await expect(
        reader(chunks(tar([[path, Buffer.from("x")]]))).read(drain),
      ).rejects.toMatchObject({ code: "unsafe_path" });
    },
  );

  it("rejects duplicate members before exposing the second body", async () => {
    let bodies = 0;
    const input = tar([
      ["a", Buffer.from("x")],
      ["a", Buffer.from("y")],
    ]);
    await expect(
      reader(chunks(input)).read(async (entry) => {
        bodies++;
        await drain(entry);
      }),
    ).rejects.toMatchObject({ code: "duplicate" });
    expect(bodies).toBe(1);
  });

  it("accepts the exact count, member and content limits", async () => {
    await reader(
      chunks(
        tar([
          ["a", Buffer.from("1234")],
          ["b", Buffer.from("5678")],
        ]),
      ),
      small,
    ).read(drain);
  });

  it.each([
    ["member bytes", small, [["a", Buffer.from("12345")]]],
    [
      "content bytes",
      { ...small, maxEntryBytes: 5 },
      [
        ["a", Buffer.from("12345")],
        ["b", Buffer.from("6789")],
      ],
    ],
    [
      "member count",
      { ...small, maxEntries: 1 },
      [
        ["a", Buffer.alloc(0)],
        ["b", Buffer.alloc(0)],
      ],
    ],
  ] as Array<[string, SourceTarLimits, Array<[string, Buffer]>]>)(
    "rejects exceeded %s",
    async (_name, limits, entries) => {
      await expect(reader(chunks(tar(entries)), limits).read(drain)).rejects.toMatchObject({
        code: "limit_exceeded",
      });
    },
  );

  it("rejects a declared oversize before pulling its body", async () => {
    let pulledBody = false;
    let closed = false;
    const input = (async function* () {
      try {
        yield tarMember("a", Buffer.from("12345")).subarray(0, 512);
        pulledBody = true;
        yield Buffer.from("12345");
      } finally {
        closed = true;
      }
    })();
    await expect(reader(input, small).read(drain)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
    expect(pulledBody).toBe(false);
    expect(closed).toBe(true);
  });

  it("bounds all raw input, including zero record padding", async () => {
    const input = tar([["a", Buffer.from("1234")]]);
    // 4 content bytes + 2 possible headers/paddings + a Python 20-block record.
    const limit = 4 + 2 * 1024 + 10240;
    const exact = Buffer.concat([input, Buffer.alloc(limit - input.length)]);
    const limits = { ...small, maxTotalBytes: 4 };
    await reader(chunks(exact), limits).read(drain);
    await expect(
      reader(chunks(Buffer.concat([exact, Buffer.alloc(1)])), limits).read(drain),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(
      reader(Readable.from([Buffer.alloc(16384)]), limits).read(drain),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it.each([0, -1, NaN, Infinity, 257])(
    "closes input for invalid entry limit %s",
    async (maxEntries) => {
      let returned = 0;
      const source = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: true as const, value: undefined }),
            return: async () => {
              returned++;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
      await expect(reader(source, { ...small, maxEntries }).read(drain)).rejects.toMatchObject({
        code: "limit_exceeded",
      });
      expect(returned).toBe(1);
    },
  );

  it.each(["skipped", "partial"])("rejects a %s consumer and closes upstream", async (mode) => {
    let closed = false;
    const source = (async function* () {
      try {
        yield* chunks(tar([["a", Buffer.alloc(20)]]));
      } finally {
        closed = true;
      }
    })();
    await expect(
      reader(source).read(async ({ content }) => {
        if (mode === "partial") for await (const _chunk of content) break;
      }),
    ).rejects.toMatchObject({ code: "truncated" });
    expect(closed).toBe(true);
  });

  it("preserves consumer failure even when upstream close throws", async () => {
    const original = new Error("consumer-failed");
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false as const, value: tar([["a", Buffer.from("x")]]) }),
          return: async () => {
            throw new Error("close-failed");
          },
        };
      },
    };
    await expect(
      reader(source).read(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("propagates upstream failure and closes the iterator", async () => {
    let closed = false;
    const original = new Error("upstream-failed");
    const source = (async function* () {
      try {
        yield tarMember("a", Buffer.from("x")).subarray(0, 512);
        throw original;
      } finally {
        closed = true;
      }
    })();
    await expect(reader(source).read(drain)).rejects.toBe(original);
    expect(closed).toBe(true);
  });

  it("propagates an aborted Node stream and closes its source", async () => {
    const controller = new AbortController();
    let closed = false;
    const source = (async function* () {
      try {
        yield tarMember("a", Buffer.alloc(128 * 1024)).subarray(0, 512);
        for (let i = 0; i < 4; i++) {
          yield Buffer.alloc(32 * 1024);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        yield Buffer.alloc(1024);
      } finally {
        closed = true;
      }
    })();
    const input = Readable.from(source, {
      objectMode: false,
      highWaterMark: 1,
      signal: controller.signal,
    });
    await expect(
      reader(input).read(async ({ content }) => {
        for await (const _chunk of content) controller.abort();
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(closed).toBe(true);
    expect(input.destroyed).toBe(true);
  });

  it("waits for body consumption without pulling the rest of the source", async () => {
    const input = tar([["a", Buffer.alloc(128 * 1024)]]);
    let pulls = 0;
    const source = (async function* () {
      for await (const chunk of chunks(input, 32 * 1024)) {
        pulls++;
        yield chunk;
      }
    })();
    await reader(source).read(async (entry) => {
      expect(pulls).toBe(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pulls).toBe(1);
      await drain(entry);
    });
    expect(pulls).toBeGreaterThan(1);
  });
});
