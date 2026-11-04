package expo.modules.openmapxintake
import org.junit.Assert.assertTrue
import org.junit.Test
class IntakeIngressTest {
  @Test fun aDisposedModuleListenerCannotCrashTheReceiverOrSuppressOtherListeners() {
    var delivered = false
    val disposed: () -> Unit = { throw IllegalStateException("disposed runtime") }
    val live: () -> Unit = { delivered = true }
    IntakeIngress.listeners.add(disposed); IntakeIngress.listeners.add(live)
    try { IntakeIngress.changed(); assertTrue(delivered) }
    finally { IntakeIngress.listeners.remove(disposed); IntakeIngress.listeners.remove(live) }
  }
}
