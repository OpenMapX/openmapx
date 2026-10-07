import { join, resolve } from "node:path";

export function parseOptions(args: string[], root: string) {
  const result = {
    out: join(root, ".superpowers/eval-reports/latest"),
    baseline: "",
    evidence: "",
  };
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--out", "--baseline", "--evidence"].includes(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    ) {
      throw new Error(
        "Usage: pnpm discovery-eval [--out DIRECTORY] [--baseline REPORT.json] [--evidence MANIFEST.json]",
      );
    }
    result[args[i].slice(2) as keyof typeof result] = resolve(root, args[i + 1]);
  }
  return result;
}
