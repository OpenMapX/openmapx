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

it.each(["Bearer", "Basic", "Token"])(
  "fix3 protects every nonempty proper %s prefix at CR and CRLF and releases following diagnostics",
  (scheme) => {
    const failures: string[] = [];
    const secret = "synthetic-review-r3-continuation";
    for (let split = 1; split < scheme.length; split++) {
      for (const ending of ["\r", "\r\n"]) {
        for (const splitBytes of [false, true]) {
          for (const stream of ["stdout", "stderr"] as const) {
            const otherStream = stream === "stdout" ? "stderr" : "stdout";
            const seen: { stream: "stdout" | "stderr"; message: string }[] = [];
            const output = createBoundedProcessOutput({
              onLine: (stream, message) => seen.push({ stream, message }),
              redact: (x) => x,
            });
            const write = (target: "stdout" | "stderr", frame: string) => {
              const bytes = Buffer.from(frame);
              if (splitBytes) for (const byte of bytes) output.write(target, Uint8Array.of(byte));
              else output.write(target, bytes);
            };
            write(stream, `Authorization: ${scheme.slice(0, split)}${ending}`);
            write(otherStream, "independent-diagnostic\n");
            write(stream, `${scheme.slice(split)} ${secret}\n`);
            write(stream, "last-diagnostic\n");
            const diagnostics = output.end();
            const callbackWithheld = !seen.some((entry) => entry.message.includes(secret));
            const tailWithheld = !diagnostics.tail.some((entry) => entry.message.includes(secret));
            const finalEntry = { stream, message: "last-diagnostic" };
            const independentEntry: typeof finalEntry = {
              stream: otherStream,
              message: "independent-diagnostic",
            };
            const includes = (entries: typeof seen, expected: typeof finalEntry) =>
              entries.some(
                (entry) => entry.stream === expected.stream && entry.message === expected.message,
              );
            const finalVisible =
              includes(seen, finalEntry) && includes(diagnostics.tail, finalEntry);
            const independentVisible =
              includes(seen, independentEntry) && includes(diagnostics.tail, independentEntry);
            if (!callbackWithheld || !tailWithheld || !finalVisible || !independentVisible)
              failures.push(
                `${scheme.slice(0, split)} + ${scheme.slice(split)}, ${JSON.stringify(ending)}, bytes=${splitBytes}, ${stream}: callbackWithheld=${callbackWithheld}, tailWithheld=${tailWithheld}, finalVisible=${finalVisible}, independentVisible=${independentVisible}`,
              );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  },
);

describe("fix4 bounded multi-CR authorization recognition", () => {
  it("withholds the credential after a second CR while Bearer is still resuming", () => {
    const seen: string[] = [];
    const output = createBoundedProcessOutput({
      onLine: (_stream, message) => seen.push(message),
      redact: (x) => x,
    });
    for (const frame of [
      "Authorization: B\r",
      "ea\r",
      "rer synthetic-review-r4-continuation\n",
      "last-diagnostic\n",
    ])
      output.write("stdout", Buffer.from(frame));
    const diagnostics = output.end();
    expect(JSON.stringify({ seen, diagnostics })).not.toContain("synthetic-review-r4-continuation");
    expect(seen).toContain("last-diagnostic");
    expect(diagnostics.tail).toContainEqual({ stream: "stdout", message: "last-diagnostic" });
  });

  it.each(["Bearer", "Basic", "Token"])(
    "withholds every nonempty %s partition across CR/CRLF and releases subsequent diagnostics",
    (scheme) => {
      const failures: string[] = [];
      let failureCount = 0;
      // Each bit cuts one character boundary; include every partition with at least one cut.
      for (let cuts = 1; cuts < 2 ** (scheme.length - 1); cuts++) {
        const parts: string[] = [];
        let start = 0;
        for (let index = 1; index < scheme.length; index++) {
          if (cuts & (1 << (index - 1))) {
            parts.push(scheme.slice(start, index));
            start = index;
          }
        }
        parts.push(scheme.slice(start));
        for (const endings of [["\r"], ["\r\n"], ["\r", "\r\n"]]) {
          for (const valueEnding of ["\n", "\r", "\r\n"]) {
            for (const pendingValue of [false, true]) {
              for (const splitBytes of [false, true]) {
                for (const stream of ["stdout", "stderr"] as const) {
                  const otherStream = stream === "stdout" ? "stderr" : "stdout";
                  const seen: { stream: "stdout" | "stderr"; message: string }[] = [];
                  const projected: string[] = [];
                  const output = createBoundedProcessOutput({
                    onLine: (stream, message) => seen.push({ stream, message }),
                    redact: (message) => {
                      projected.push(message);
                      return message;
                    },
                  });
                  const write = (target: "stdout" | "stderr", frame: string) => {
                    const bytes = Buffer.from(frame);
                    if (splitBytes)
                      for (const byte of bytes) output.write(target, Uint8Array.of(byte));
                    else output.write(target, bytes);
                  };
                  for (let index = 0; index < parts.length; index++) {
                    const prefix = index === 0 ? "Authorization: " : "";
                    const ending = endings[index % endings.length];
                    if (index < parts.length - 1) {
                      write(stream, `${prefix}${parts[index]}${ending}`);
                      write(otherStream, "independent-diagnostic\n");
                    } else {
                      const separator = pendingValue ? ending : " ";
                      write(
                        stream,
                        `${prefix}${parts[index]}${separator}synthetic-review-r4-value${valueEnding}`,
                      );
                    }
                  }
                  write(stream, "last-diagnostic\n");
                  const diagnostics = output.end();
                  const withheld = !JSON.stringify({ seen, diagnostics, projected }).includes(
                    "synthetic-review-r4-value",
                  );
                  const includes = (
                    entries: typeof seen,
                    target: "stdout" | "stderr",
                    message: string,
                  ) =>
                    entries.some((entry) => entry.stream === target && entry.message === message);
                  const finalVisible =
                    includes(seen, stream, "last-diagnostic") &&
                    includes(diagnostics.tail, stream, "last-diagnostic");
                  const independentVisible =
                    includes(seen, otherStream, "independent-diagnostic") &&
                    includes(diagnostics.tail, otherStream, "independent-diagnostic");
                  if (!withheld || !finalVisible || !independentVisible) {
                    failureCount++;
                    if (failures.length < 10)
                      failures.push(
                        `${parts.join(" + ")}, ${JSON.stringify(endings)}, valueEnding=${JSON.stringify(valueEnding)}, pending=${pendingValue}, bytes=${splitBytes}, ${stream}: withheld=${withheld}, finalVisible=${finalVisible}, independentVisible=${independentVisible}`,
                      );
                  }
                }
              }
            }
          }
        }
      }
      expect({ failureCount, examples: failures }).toEqual({ failureCount: 0, examples: [] });
    },
  );

  it.each(["\r", "\r\n"])(
    "releases a rejected scheme prefix instead of latching over later diagnostics (%j)",
    (ending) => {
      const seen: string[] = [];
      const output = createBoundedProcessOutput({
        onLine: (_stream, message) => seen.push(message),
        redact: (x) => x,
      });
      for (const frame of [
        `Authorization: B${ending}`,
        `ea${ending}`,
        "not-a-scheme\n",
        "last-diagnostic\n",
        "another-diagnostic\n",
      ])
        output.write("stdout", Buffer.from(frame));
      const diagnostics = output.end();
      for (const message of ["last-diagnostic", "another-diagnostic"]) {
        expect(seen).toContain(message);
        expect(diagnostics.tail).toContainEqual({ stream: "stdout", message });
      }
    },
  );
});
