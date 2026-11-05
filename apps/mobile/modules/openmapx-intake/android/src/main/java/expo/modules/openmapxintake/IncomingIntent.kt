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
  @Suppress("DEPRECATION")
  fun attachments(intent: Intent): List<Uri> {
    val streams = when (intent.action) {
      Intent.ACTION_VIEW -> listOfNotNull(intent.data)
      Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
      Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
      else -> emptyList()
    }
    // Rich text previews use ClipData for thumbnails. Only stream extras declare files.
    if (intent.action == Intent.ACTION_SEND && streams.isEmpty()) return emptyList()
    if (streams.size > 5) throw IntakeFailure("too-many")
    val uris = streams.toMutableList()
    if (streams.isNotEmpty() && intent.action == Intent.ACTION_SEND_MULTIPLE) intent.clipData?.let { clip ->
      if (clip.itemCount > 5) throw IntakeFailure("too-many")
      for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { if (it !in uris) uris += it }
    }
    if (uris.size > 5) throw IntakeFailure("too-many")
    return uris
  }
  fun isForeignContent(uri: Uri, ownAuthorities: Set<String>, resolvedUid: Int?, ownUid: Int): Boolean =
    uri.scheme == "content" && !uri.authority.isNullOrEmpty() && uri.authority !in ownAuthorities && resolvedUid != ownUid
}
