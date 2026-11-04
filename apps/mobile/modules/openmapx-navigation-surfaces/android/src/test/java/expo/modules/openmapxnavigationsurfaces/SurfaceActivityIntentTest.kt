package expo.modules.openmapxnavigationsurfaces

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class SurfaceActivityIntentTest {
  @Test fun sendsOpenAndIdentityBoundEndThroughReactNativeViewIntents() {
    val component = ComponentName("org.example.maps", "org.example.maps.MainActivity")
    for (path in listOf("active", "end?sessionId=session-1")) {
      val uri = Uri.parse("openmapx-dev:///navigation/$path")
      val intent = surfaceActivityIntent(component, uri)
      // React Native getInitialURL/onNewIntent only forward VIEW (or NFC).
      assertEquals(Intent.ACTION_VIEW, intent.action)
      assertEquals(uri, intent.data)
      assertEquals(component, intent.component)
      assertTrue(intent.flags and Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
      assertTrue(intent.flags and Intent.FLAG_ACTIVITY_CLEAR_TOP != 0)
      assertFalse(intent.categories?.contains(Intent.CATEGORY_LAUNCHER) ?: false)
    }
  }
}
