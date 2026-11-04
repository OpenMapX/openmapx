package expo.modules.openmapxintake

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class IncomingIntentTest {
  @Test fun rejectsHistoryAndSavedStateButAcceptsFreshShare() {
    val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Station")
    assertTrue(IncomingIntent.shouldCapture(intent, null))
    assertFalse(IncomingIntent.shouldCapture(intent, Bundle()))
    assertFalse(IncomingIntent.shouldCapture(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY), null))
  }
  @Test fun leavesMapAndNativeEndIntentsAlone() {
    assertFalse(IncomingIntent.shouldCapture(Intent(Intent.ACTION_VIEW, Uri.parse("geo:50,8")), null))
    assertFalse(IncomingIntent.shouldCapture(Intent(Intent.ACTION_VIEW, Uri.parse("openmapx:///navigation/end?sessionId=old")), null))
  }
  @Test fun fileInputMustBeForeignContentAndVisibilityNullDoesNotRefuseIt() {
    assertTrue(IncomingIntent.isForeignContent(Uri.parse("content://foreign.provider/file"), setOf("our.provider"), null, 123))
    assertFalse(IncomingIntent.isForeignContent(Uri.parse("content://our.provider/file"), setOf("our.provider"), null, 123))
    assertFalse(IncomingIntent.isForeignContent(Uri.parse("content://alias.provider/file"), emptySet(), 123, 123))
    assertFalse(IncomingIntent.isForeignContent(Uri.parse("file:///private/route.gpx"), emptySet(), null, 123))
  }
}
