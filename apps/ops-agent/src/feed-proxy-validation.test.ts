import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runContainedProcess } from "./docker-runtime";
import {
  createFeedProxyValidationInvocation,
  parseFeedProxyValidationCompletion,
} from "./feed-proxy-validation";

const execution = {
  executor: "ops-agent" as const,
  principal: "data-manager" as const,
  executionId: "job1_aaaaaaaaaaaaaaaa",
  operationKey: "opk1_aaaaaaaaaaaaaaaa",
  operationFingerprint: "a".repeat(64),
  fingerprint: "b".repeat(64),
  deadlineAt: Date.now() + 60000,
};
it.each([0, 1, 255])(
  "observes nginx exit %s only after the real fixed wrapper exits normally with its nonce",
  async (code) => {
    const root = mkdtempSync(join(tmpdir(), "omx-nginx-wrapper-"));
    mkdirSync(join(root, "bin"));
    writeFileSync(
      join(root, "bin/nginx"),
      `#!/bin/sh\nprintf 'validation diagnostics\\n' >&2\nexit ${code}\n`,
      { mode: 0o700 },
    );
    try {
      const invocation = createFeedProxyValidationInvocation();
      const result = await runContainedProcess(
        "/bin/sh",
        [
          "-c",
          'PATH="$1:$PATH"; export PATH; shift; exec "$@"',
          "docker-io-substitute",
          join(root, "bin"),
          ...invocation.args,
        ],
        { signal: new AbortController().signal, timeout: 5000, maxBuffer: 4096 },
      );
      const parsed = parseFeedProxyValidationCompletion(
        result.stdout,
        invocation.nonce,
        execution,
        "c".repeat(64),
      );
      expect(parsed.validationExitCode).toBe(code);
      expect(parsed.output).not.toContain("OPENMAPX_NGINX_TEST");
      expect(parsed.completionDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.stderr).toContain("validation diagnostics");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it.each([
  "missing",
  "duplicate",
  "foreign",
  "negative",
  "overflow",
  "malformed",
  "truncated",
  "trailing",
] as const)("refuses a %s completion marker", (mode) => {
  const invocation = createFeedProxyValidationInvocation(),
    marker = `OPENMAPX_NGINX_TEST_V1:${invocation.nonce}:1`;
  const outputs = {
    missing: "nginx failed\n",
    duplicate: marker + "\n" + marker + "\n",
    foreign: marker.replace(invocation.nonce, "a".repeat(22)) + "\n",
    negative: marker.replace(":1", ":-1") + "\n",
    overflow: marker.replace(":1", ":256") + "\n",
    malformed: marker.replace(":1", ":01") + "\n",
    truncated: marker,
    trailing: marker + "\nuntrusted\n",
  };
  expect(() =>
    parseFeedProxyValidationCompletion(outputs[mode], invocation.nonce, execution, "c".repeat(64)),
  ).toThrow();
});
it.each(["abort", "timeout", "truncation", "nonzero", "residual"] as const)(
  "the actual contained runner refuses %s instead of producing validation evidence",
  async (mode) => {
    const controller = new AbortController();
    if (mode === "abort") controller.abort();
    const script =
      mode === "nonzero"
        ? "process.exit(1)"
        : mode === "truncation"
          ? "process.stdout.write('x'.repeat(10000))"
          : mode === "residual"
            ? "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.exit(0)"
            : "setInterval(()=>{},1000)";
    await expect(
      runContainedProcess(process.execPath, ["-e", script], {
        signal: controller.signal,
        timeout: mode === "timeout" ? 30 : 3000,
        maxBuffer: 128,
        killGraceMs: 20,
      }),
    ).rejects.toThrow();
  },
  10000,
);
