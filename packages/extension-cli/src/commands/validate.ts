import { validateIntegrationDirectory } from "@openmapx/integration-framework/installer";

export async function runValidate(source: string): Promise<void> {
  const result = validateIntegrationDirectory(source);

  if (result.valid) {
    console.log(`✓ ${result.id}: valid`);
  } else {
    console.error(`✗ ${result.id}: invalid`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
}
