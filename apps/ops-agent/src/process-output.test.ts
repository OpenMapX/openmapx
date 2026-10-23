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
