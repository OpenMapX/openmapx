package expo.modules.openmapxnavigationsurfaces

import android.content.ComponentName
import android.content.Intent
import android.net.Uri

/** Explicit host activity, with VIEW so React Native receives cold and warm links. */
internal fun surfaceActivityIntent(component: ComponentName, uri: Uri): Intent =
  Intent(Intent.ACTION_VIEW, uri).setComponent(component)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
