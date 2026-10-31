import { randomBytes } from "node:crypto";
import { feedProxyValidationCompletionDigest } from "@openmapx/core/build-artifacts";
import type { ExecutionRef } from "@openmapx/core/ops";

export const FEED_PROXY_VALIDATION_SCRIPT =
  'nginx -t\nvalidation_status=$?\nprintf "\\nOPENMAPX_NGINX_TEST_V1:%s:%s\\n" "$1" "$validation_status"\nexit 0';
const PREFIX = "OPENMAPX_NGINX_TEST_V1:";
export function createFeedProxyValidationInvocation() {
  const nonce = randomBytes(16).toString("base64url");
  return {
    nonce,
    args: ["/bin/sh", "-c", FEED_PROXY_VALIDATION_SCRIPT, "openmapx-nginx-test", nonce],
  };
}
/** Called only after the strict contained runner's normal zero completion. */
export function parseFeedProxyValidationCompletion(
  stdout: string,
  nonce: string,
  execution: ExecutionRef,
  candidateDigest: string,
) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(nonce)) throw Error("Invalid validation invocation");
  const lines = stdout.split("\n");
  if (lines.at(-1) !== "") throw Error("Incomplete validation completion marker");
  lines.pop();
  const marker = lines.pop();
  const match = marker?.match(/^OPENMAPX_NGINX_TEST_V1:([A-Za-z0-9_-]{22}):(0|[1-9][0-9]{0,2})$/);
  if (
    !match ||
    match[1] !== nonce ||
    Number(match[2]) > 255 ||
    lines.some((line) => line.includes(PREFIX))
  )
    throw Error("Missing, foreign or repeated validation completion marker");
  const validationExitCode = Number(match[2]);
  return {
    validationExitCode,
    completionDigest: feedProxyValidationCompletionDigest(
      execution,
      candidateDigest,
      nonce,
      validationExitCode,
    ),
    output: lines.join("\n"),
  };
}
