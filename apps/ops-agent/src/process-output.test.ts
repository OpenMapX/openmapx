import { describe, expect, it } from "vitest";
import { createBoundedProcessOutput } from "./process-output";

describe("bounded live process output", () => {
  it("decodes split UTF8 and frames CR/LF before exit", () => {
    const seen: string[] = [];
    const output = createBoundedProcessOutput({
      onLine: (_, line) => seen.push(line),
      redact: (x) => x,
    });
    output.write("stdout", Buffer.from([0xf0, 0x9f]));
    output.write("stdout", Buffer.from([0x98, 0x80, 13, 10]));
    output.write("stderr", Buffer.from("progress\rnext\ntail"));
    expect(seen).toEqual(["😀", "progress", "next"]);
    expect(output.end().tail.map((x) => x.message)).toEqual(["😀", "progress", "next", "tail"]);
  });
  it("scrubs credentials across chunks, controls and frame boundaries", () => {
    const seen: string[] = [];
    const output = createBoundedProcessOutput({
      onLine: (_, line) => seen.push(line),
      redact: (x) => x,
    });
    for (const chunk of [
      "https://user:pas",
      "s@host/path?token=private\nAuthor",
      "ization: Bearer hidden\npass",
      "word=",
      "topsecret\n\u001b[31mhello\u001b[0m\u0000\npassword=\n",
      "continuedsecret\n",
      `${"x".repeat(4090)} token=`,
      "secret-crossing-boundary\nlast-diagnostic\n",
    ])
      output.write("stdout", Buffer.from(chunk));
    const result = output.end();
    const text = JSON.stringify({ seen, result });
    for (const secret of [
      "private",
      "user:pass",
      "hidden",
      "topsecret",
      "continuedsecret",
      "secret-crossing-boundary",
      "\\u001b",
      "\\u0000",
    ])
      expect(text).not.toContain(secret);
    expect(seen).toContain("hello");
    expect(seen).toContain("last-diagnostic");
    expect(result.truncated).toBe(true);
  });
  it("drains noisy and unterminated output and retains the final meaningful tail", () => {
    const output = createBoundedProcessOutput({ onLine: () => undefined, redact: (x) => x });
    for (let i = 0; i < 2048; i++) output.write("stdout", Buffer.from(`${"x".repeat(1024)}\n`));
    output.write("stderr", Buffer.from("y".repeat(1024 * 1024)));
    output.write("stderr", Buffer.from("\nlast-diagnostic\n"));
    const result = output.end();
    expect(result.truncated).toBe(true);
    expect(result.tail[0]?.message).toBe("[output truncated]");
    expect(result.tail.at(-1)?.message).toBe("last-diagnostic");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(result.tail.every((x) => Buffer.byteLength(x.message) <= 4096)).toBe(true);
  });
  it("detaches a failed callback and continues safe diagnostics", () => {
    let calls = 0;
    const output = createBoundedProcessOutput({
      onLine: () => {
        calls++;
        throw Error("sink");
      },
      redact: (x) => x,
    });
    output.write("stdout", Buffer.from("one\ntwo\n"));
    expect(output.end()).toMatchObject({
      truncated: true,
      tail: expect.arrayContaining([{ stream: "stdout", message: "two" }]),
    });
    expect(calls).toBe(1);
  });
});

it("withholds an unterminated quoted credential across multiple real frames", () => {
  const seen: string[] = [];
  const output = createBoundedProcessOutput({
    onLine: (_s, line) => seen.push(line),
    redact: (x) => x,
  });
  for (const chunk of [
    'password="first-secret\n',
    "second-secret\r",
    'third-secret"\n',
    "last-diagnostic\n",
  ])
    output.write("stdout", Buffer.from(chunk));
  const text = JSON.stringify({ seen, diagnostics: output.end() });
  for (const secret of ["first-secret", "second-secret", "third-secret"])
    expect(text).not.toContain(secret);
  expect(seen).toContain("last-diagnostic");
});

describe("fix1 credential boundary regressions", () => {
  it.each([
    'pass\x1b(Bword="synthetic-first\n',
    'pass\x90control\x9cword="synthetic-first\n',
    'password=closed;token="synthetic-first\n',
    'password="closed" token="synthetic-first\n',
    'pass\x1b[31mword="synthetic-first\n',
  ])("tracks every normalized open assignment: %j", (first) => {
    const seen: string[] = [];
    const output = createBoundedProcessOutput({
      onLine: (_s, line) => seen.push(line),
      redact: (x) => x,
    });
    for (const frame of [
      first,
      'synthetic-continuation\\"still-open\n',
      'synthetic-final"\n',
      "last-diagnostic\n",
    ])
      output.write("stdout", Buffer.from(frame));
    const all = JSON.stringify({ seen, diagnostics: output.end() });
    for (const secret of ["synthetic-first", "synthetic-continuation", "synthetic-final"])
      expect(all).not.toContain(secret);
    expect(seen).toContain("last-diagnostic");
  });
  it.each([" https://synthetic-user", " https://synthetic-user:443"])(
    "withholds ambiguous URL userinfo at an artificial boundary: %s",
    (suffix) => {
      const prefix = "x".repeat(4096 - Buffer.byteLength(suffix)) + suffix;
      const seen: string[] = [];
      const output = createBoundedProcessOutput({
        onLine: (_s, line) => seen.push(line),
        redact: (x) => x,
      });
      output.write("stdout", Buffer.from(prefix));
      output.write("stdout", Buffer.from("@host.invalid/path\nlast-diagnostic\n"));
      expect(JSON.stringify({ seen, diagnostics: output.end() })).not.toContain("synthetic-user");
      expect(seen).toContain("last-diagnostic");
    },
  );
});

it("fix1 withholds a quoted assignment whose delimiter follows a real frame boundary", () => {
  const seen: string[] = [];
  const output = createBoundedProcessOutput({
    onLine: (_s, line) => seen.push(line),
    redact: (x) => x,
  });
  for (const frame of [
    "password\n",
    '="synthetic-key-continuation\n',
    'synthetic-value-continuation"\n',
    "last-diagnostic\n",
  ])
    output.write("stdout", Buffer.from(frame));
  const all = JSON.stringify({ seen, result: output.end() });
  expect(all).not.toContain("synthetic-key-continuation");
  expect(all).not.toContain("synthetic-value-continuation");
  expect(seen).toContain("last-diagnostic");
});

describe("fix2 credential continuation parity", () => {
  it.each(["accesstoken", "accessToken", "ACCESSTOKEN"])(
    "withholds quoted %s continuations with every real line ending and byte split",
    (key) => {
      const observed: unknown[] = [];
      for (const ending of ["\n", "\r\n", "\r"]) {
        for (const splitBytes of [false, true]) {
          const seen: string[] = [];
          const output = createBoundedProcessOutput({
            onLine: (_stream, line) => seen.push(line),
            redact: (x) => x,
          });
          for (const frame of [
            `${key}="synthetic-access-first${ending}`,
            `synthetic-access-second"${ending}`,
            `last-diagnostic${ending}`,
          ]) {
            const bytes = Buffer.from(frame);
            if (splitBytes) for (const byte of bytes) output.write("stdout", Uint8Array.of(byte));
            else output.write("stdout", bytes);
          }
          const diagnostics = output.end();
          expect(seen).toContain("last-diagnostic");
          expect(diagnostics.tail.at(-1)?.message).toBe("last-diagnostic");
          observed.push({ ending, splitBytes, seen, diagnostics });
        }
      }
      const all = JSON.stringify(observed);
      expect(all).not.toContain("synthetic-access-first");
      expect(all).not.toContain("synthetic-access-second");
    },
  );

  it.each(["Bearer", "Basic", "Token"])(
    "retains Authorization %s awaiting its value across every real line ending and byte split",
    (scheme) => {
      const observed: unknown[] = [];
      for (const ending of ["\n", "\r\n", "\r"]) {
        for (const splitBytes of [false, true]) {
          const seen: string[] = [];
          const output = createBoundedProcessOutput({
            onLine: (_stream, line) => seen.push(line),
            redact: (x) => x,
          });
          for (const frame of [
            `Authorization: ${scheme}${ending}`,
            `synthetic-authorization-value${ending}`,
            `last-diagnostic${ending}`,
          ]) {
            const bytes = Buffer.from(frame);
            if (splitBytes) for (const byte of bytes) output.write("stdout", Uint8Array.of(byte));
            else output.write("stdout", bytes);
          }
          const diagnostics = output.end();
          expect(seen).toContain("last-diagnostic");
          expect(diagnostics.tail.at(-1)?.message).toBe("last-diagnostic");
          observed.push({ ending, splitBytes, seen, diagnostics });
        }
      }
      expect(JSON.stringify(observed)).not.toContain("synthetic-authorization-value");
    },
  );
});

it("fix2 preserves inline authorization CR continuation protection", () => {
  for (const scheme of ["Bearer", "Basic", "Token"]) {
    const seen: string[] = [];
    const output = createBoundedProcessOutput({
      onLine: (_stream, line) => seen.push(line),
      redact: (x) => x,
    });
    for (const frame of [
      `Authorization: ${scheme} synthetic-inline-value\r`,
      "synthetic-inline-continuation\r",
      "last-diagnostic\n",
    ])
      output.write("stdout", Buffer.from(frame));
    const diagnostics = output.end();
    expect(JSON.stringify({ seen, diagnostics })).not.toContain("synthetic-inline-");
    expect(seen).toContain("last-diagnostic");
  }
});

it("fix2 still tracks a quoted assignment used as an authorization value", () => {
  for (const prefix of ["Authorization: Bearer ", "Authorization: Bearer\n"]) {
    const seen: string[] = [];
    const output = createBoundedProcessOutput({
      onLine: (_stream, line) => seen.push(line),
      redact: (x) => x,
    });
    for (const frame of [
      `${prefix}token="synthetic-nested-first\n`,
      'synthetic-nested-second"\n',
      "last-diagnostic\n",
    ])
      output.write("stdout", Buffer.from(frame));
    expect(JSON.stringify({ seen, diagnostics: output.end() })).not.toContain("synthetic-nested-");
    expect(seen).toContain("last-diagnostic");
  }
});
