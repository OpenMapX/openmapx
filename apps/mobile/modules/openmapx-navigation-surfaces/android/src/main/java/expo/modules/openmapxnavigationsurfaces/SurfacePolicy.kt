package expo.modules.openmapxnavigationsurfaces

/** No Android types: ordering policy is tested on the JVM. */
object SurfacePolicy {
  const val TAG = "openmapx:navigation-surface"
  const val ID = 1
  const val MAX_BYTES = 3000
  fun accepts(owner: String?, revision: Long, incomingOwner: String, incomingRevision: Long): Boolean =
    incomingOwner.matches(Regex("[A-Za-z0-9_-]{1,128}")) && incomingRevision >= 0 &&
      (owner != incomingOwner || incomingRevision >= revision)
  fun canClear(owner: String?, expected: String?): Boolean = expected == null || owner == expected
  fun userDismissedBeforeExpiry(now: Long, staleAt: Long): Boolean = now < staleAt
}
