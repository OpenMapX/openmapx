// Setup for the `node` vitest project.
//
// The Transitous pipeline's `preflight` stage sizes MOTIS's disk needs at
// ~25 GB (candidate + rollback headroom) and compares that against the live
// filesystem via statfsSync. Unit tests that drive the pipeline through
// preflight would otherwise pass or fail on the runner's incidental free disk.
// Pin the measured capacity to a large deterministic value so those tests
// exercise pipeline logic, not the host's disk. Production never sets this and
// still measures real disk; `??=` lets an individual test opt into its own
// value (e.g. to exercise the insufficient-disk path).
process.env.MOTIS_FREE_DISK_BYTES ??= String(1024 ** 4); // 1 TiB
