package expo.modules.openmapxintake

import android.content.Intent
import android.net.Uri
import android.os.Bundle

object IncomingIntent {
  fun shouldCapture(intent: Intent, savedState: Bundle?): Boolean {
    if (savedState != null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return false
    return when (intent.action) {
      Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> true
      Intent.ACTION_VIEW -> intent.data?.scheme == "content"
      else -> false
    }
  }
  fun isForeignContent(uri: Uri, ownAuthorities: Set<String>, resolvedUid: Int?, ownUid: Int): Boolean =
    uri.scheme == "content" && !uri.authority.isNullOrEmpty() && uri.authority !in ownAuthorities && resolvedUid != ownUid
}
