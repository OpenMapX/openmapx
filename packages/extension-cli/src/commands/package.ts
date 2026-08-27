import { resolve } from "node:path";
import { packageIntegration } from "@openmapx/integration-framework/installer";

export interface PackageCommandOptions {
  source: string;
  out: string;
  /** Print the exact allowlisted file list and total bytes; write nothing. */
  dryRun?: boolean;
}

export async function runPackage(opts: PackageCommandOptions): Promise<void> {
  const { source, out, dryRun = false } = opts;

  const result = await packageIntegration({
    rootDir: process.cwd(),
    source: resolve(source),
    outFile: resolve(out),
    dryRun,
    onLog: (line, stream) => {
      if (stream === "stderr") {
        console.error(line);
      } else {
        console.log(line);
      }
    },
  });

  if (dryRun) {
    console.log(
      `Would package ${result.files?.length ?? 0} files (${result.totalBytes ?? 0} bytes)`,
    );
    return;
  }
  console.log(`Packaged integration: ${result.id}`);
  console.log(`Artifact: ${result.artifactPath}`);
}
