package expo.modules.openmapxnavigationsurfaces
import org.junit.Assert.*
import org.junit.Test
class SurfacePolicyTest {
  @Test fun fencesOldRevisionsAndClears() {
    assertFalse(SurfacePolicy.accepts("A", 2, "A", 1))
    assertTrue(SurfacePolicy.accepts("A", 2, "B", 1))
    assertFalse(SurfacePolicy.canClear("B", "A"))
    assertTrue(SurfacePolicy.canClear("B", "B"))
    assertFalse(SurfacePolicy.accepts(null, 0, "//bad", 1))
  }
  @Test fun distinguishesDismissalFromExpiry() {
    assertTrue(SurfacePolicy.userDismissedBeforeExpiry(100, 200))
    assertFalse(SurfacePolicy.userDismissedBeforeExpiry(200, 200))
  }
}
