package expo.modules.openmapxintake

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class OpenMapXIntakeModule : Module() {
  private val changed: () -> Unit = { sendEvent("onInboxChanged", emptyMap<String, Any>()) }
  private fun inbox() = IntakeIngress.inbox(appContext.reactContext ?: throw IntakeFailure("unavailable"))
  private fun result(work: () -> Map<String, Any>): Map<String, Any> = try { work() } catch (e: Exception) { mapOf("errorCode" to ((e as? IntakeFailure)?.code ?: "unavailable")) }
  override fun definition() = ModuleDefinition {
    Name("OpenMapXIntake")
    Events("onInboxChanged")
    OnCreate { IntakeIngress.listeners.add(changed) }
    OnDestroy { IntakeIngress.listeners.remove(changed) }
    AsyncFunction("isAvailableAsync") { true }
    AsyncFunction("listAsync") { result { mapOf("items" to inbox().list().map { it.map() }) } }
    AsyncFunction("readChunkAsync") { id: String, offset: Int -> result { inbox().readChunk(id, offset).map() } }
    AsyncFunction("completeAsync") { id: String -> result { inbox().complete(id); mapOf("ok" to true) } }
  }
}
