package expo.modules.openmapxintake

import android.app.Activity
import android.content.ClipData
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/** No history/task affinity: the React task always keeps a neutral MAIN root intent. */
open class IntakeReceiverActivity : Activity() {
  protected open fun mainComponent(): ComponentName? = packageManager.getLaunchIntentForPackage(packageName)?.component
  protected open fun enqueue(source: Intent) { IntakeIngress.capture(this, source) }
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    receive(intent, savedInstanceState)
  }
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receive(intent, null)
  }
  private fun receive(source: Intent, savedState: Bundle?) {
    try {
      if (!IncomingIntent.shouldCapture(source, savedState)) return
      val component = mainComponent() ?: return
      val grants = try { IncomingIntent.attachments(source).filter { it.scheme == "content" } } catch (_: Exception) { emptyList() }
      // Create/restore the singleTask host with a clean task root, even on a cold share.
      // Deliver grants separately through onNewIntent so Recents never replays them.
      // Never forward source actions, extras, data, write or persistable authority.
      startActivity(neutralMainIntent(component, emptyList(), 0))
      if (grants.isNotEmpty() && source.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0) {
        startActivity(neutralMainIntent(component, grants, source.flags))
      }
      enqueue(Intent(source))
    } catch (_: Exception) {
      IntakeIngress.reportError(this, "unreadable")
      // A refused grant must not crash a running trip. Try opening only the host.
      try { mainComponent()?.let { startActivity(neutralMainIntent(it, emptyList(), 0)) } } catch (_: Exception) {}
    } finally { finish() }
  }
}

internal fun neutralMainIntent(component: ComponentName, grants: List<Uri>, sourceFlags: Int): Intent =
  Intent(Intent.ACTION_MAIN).setComponent(component).addCategory(Intent.CATEGORY_LAUNCHER)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).apply {
      if (grants.isNotEmpty() && sourceFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0) {
        clipData = ClipData.newRawUri("OpenMapX intake", grants.first()).also { clip -> grants.drop(1).forEach { clip.addItem(ClipData.Item(it)) } }
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    }
