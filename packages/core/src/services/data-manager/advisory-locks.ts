/**
 * Every PostgreSQL advisory lock data-manager and its configuration fence take,
 * by name, so no two purposes share a key by accident. A pair is
 * `(namespace, key)`; a single number is a one-key lock.
 *
 * The API takes its own locks (administrative and integration writers in the
 * `0x4f4d58`/`0x494e54` namespaces, account, privacy, platform, transit
 * credential and migration locks); none of them uses a key listed here.
 */
export const DATA_ADVISORY_LOCKS = {
  /** Data admission against the configuration fence: taken exclusively by a
   * fence change and by durable execution admission, shared by other writers. */
  dataAdmission: [0x4f4d58, 2],
  /** One Overture workflow at a time. Germany and planet nearby-places
   * builds take it shared while they read Overture's tables. A regional
   * build takes no source lock; it refuses to publish when a source table
   * was replaced while it read. */
  overture: [1_330_466_120, 1],
  /** One search-index build at a time. Germany and planet nearby-places
   * builds take it shared while they read the index's tables; a regional
   * build does not, as for `overture`. */
  searchIndex: [1_330_466_120, 2],
  /** One notable-places build at a time. */
  notablePlaces: [1_330_466_120, 3],
  /** Ambient publication: its writer exclusively, readers of its schema shared. */
  ambientPublication: 139399,
  /** One cleanup of retired ambient partitions at a time; others skip theirs. */
  ambientPartitionCleanup: [1_330_466_120, 4],
  /** Creating the Overture embedding cache, which concurrent builds share. */
  overtureEmbeddingCacheSetup: [1_330_466_120, 5],
  /** Offline package accounting: the global lock, then the seeds that hash a
   * principal and a request key into their own locks. */
  offlineAccountingGlobal: 606,
  offlineAccountingPrincipalSeed: 604,
  offlineAccountingRequestSeed: 605,
} as const;
