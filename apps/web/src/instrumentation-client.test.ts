// @vitest-environment node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const instrumentation = new URL("./instrumentation-client.ts", import.meta.url).href;

it.each(["esm", "cjs"])(
  "constructs and validates real %s Zod schemas without attempting eval under CSP",
  (variant) => {
    // Each module build caches its eval probe. A fresh process also proves that
    // configuring the ESM core reaches a later CJS consumer.
    const source = `
      import { existsSync } from 'node:fs';
      import { createRequire } from 'node:module';
      import { fileURLToPath } from 'node:url';
      let attempts = 0;
      globalThis.Function = new Proxy(globalThis.Function, {
        construct() { attempts++; throw new EvalError('CSP refuses eval'); },
        apply() { attempts++; throw new EvalError('CSP refuses eval'); },
      });
      const entry = new URL(${JSON.stringify(instrumentation)});
      // Next's client instrumentation convention is optional. On the old
      // baseline this skips the absent file and exposes the real Zod probe.
      if (existsSync(fileURLToPath(entry))) await import(entry.href);
      const require = createRequire(new URL('./package.json', import.meta.url));
      const zod = ${JSON.stringify(variant)} === 'esm'
        ? await import('zod')
        : require('zod');
      const core = ${JSON.stringify(variant)} === 'esm'
        ? import.meta.resolve('zod/v4/core')
        : require.resolve('zod/v4/core');
      const schema = zod.z.object({ name: zod.z.string(), count: zod.z.number().int() });
      const valid = schema.parse({ name: 'morning', count: 2 });
      const invalid = schema.safeParse({ name: 1, count: '2' });
      if (invalid.success) throw Error('Invalid input was accepted');
      console.log(JSON.stringify({
        attempts, core, valid,
        issues: invalid.error.issues.map(({ code, path }) => ({ code, path })),
      }));
    `;
    const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        "--input-type=module",
        "-e",
        source,
      ],
      { cwd: webRoot, env, encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect({ status: child.status, stderr: child.stderr }).toMatchObject({ status: 0 });
    const result = JSON.parse(child.stdout);
    expect(result.core).toMatch(
      variant === "esm" ? /\/zod\/v4\/core\/index\.js$/ : /\/zod\/v4\/core\/index\.cjs$/,
    );
    expect(result.valid).toEqual({ name: "morning", count: 2 });
    expect(result.issues).toEqual([
      { code: "invalid_type", path: ["name"] },
      { code: "invalid_type", path: ["count"] },
    ]);
    expect(result.attempts).toBe(0);
  },
);
