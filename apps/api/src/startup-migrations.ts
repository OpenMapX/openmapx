/**
 * The database schema is mandatory initialization, not a best-effort feature.
 *
 * Keeping the gate in a small dependency-injected function makes the startup
 * contract testable without importing `server.ts`, whose module binds sockets
 * and installs process handlers as part of its production entry point.
 */

export interface RequiredMigrationOptions {
  migrationsDirectory: string;
  directoryExists: (directory: string) => boolean;
  migrate: () => Promise<unknown>;
}

export class RequiredMigrationError extends Error {
  override readonly name = "RequiredMigrationError";
}

export async function applyRequiredMigrations(options: RequiredMigrationOptions): Promise<void> {
  if (!options.directoryExists(options.migrationsDirectory)) {
    throw new RequiredMigrationError("Required database migrations are missing");
  }

  try {
    await options.migrate();
  } catch (cause) {
    throw new RequiredMigrationError("Required database migration failed", { cause });
  }
}
