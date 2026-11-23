/**
 * The time zone every OpenMapX database session runs in, whatever the
 * database's default. Better Auth's `timestamp` columns hold UTC wall time
 * only because of this, and casts between text and time stay unambiguous.
 * postgres.js connections pass it as the `TimeZone` startup parameter;
 * PostgreSQL client programs receive it as `PGTZ`.
 */
export const DATABASE_SESSION_TIME_ZONE = "UTC";
