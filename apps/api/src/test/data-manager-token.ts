import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A private file holding `token`, for `DATA_MANAGER_TOKEN_FILE` in tests. */
export function dataManagerTokenFile(token: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "openmapx-dm-token-")), "token");
  writeFileSync(path, token, { mode: 0o600 });
  return path;
}
