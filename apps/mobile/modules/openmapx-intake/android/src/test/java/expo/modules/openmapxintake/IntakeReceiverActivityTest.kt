package expo.modules.openmapxintake
import android.content.ComponentName
import android.content.Intent
import android.content.ClipData
import android.net.Uri
import android.os.Bundle
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class IntakeReceiverActivityTest {
  class Receiver : IntakeReceiverActivity() {
    val received = mutableListOf<Intent>()
    val launches = mutableListOf<Intent>()
    override fun startActivity(intent: Intent) { launches += Intent(intent); super.startActivity(intent) }
    override fun mainComponent() = ComponentName("test.app", "test.app.MainActivity")
    override fun enqueue(source: Intent) { received += source; assertNotNull(shadowOf(this).peekNextStartedActivity()) }
  }
  private fun text() = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Station")
  @Test fun mainTaskNeverStoresAReplayableShareEvenWhenExpoDiscardsItsBundle() {
    val receiver = Robolectric.buildActivity(Receiver::class.java, text()).create().get()
    assertEquals(1, receiver.received.size)
    val main = shadowOf(receiver).nextStartedActivity
    assertEquals(Intent.ACTION_MAIN, main.action)
    assertFalse(IncomingIntent.shouldCapture(main, null)) // Expo's actual super.onCreate(null) path.
    assertFalse(main.hasExtra(Intent.EXTRA_TEXT)); assertTrue(receiver.isFinishing)
  }
  @Test fun forwardsReadOnlyGrantsForTheHostTaskBeforeCopyStarts() {
    val uri = Uri.parse("content://foreign/route.gpx")
    val share = Intent(Intent.ACTION_SEND).setType("application/gpx+xml").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    val receiver = Robolectric.buildActivity(Receiver::class.java, share).create().get()
    assertEquals(2, receiver.launches.size)
    val root = receiver.launches[0]
    assertEquals(Intent.ACTION_MAIN, root.action)
    assertNull(root.clipData)
    assertEquals(0, root.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION))
    val main = receiver.launches[1]
    assertEquals(uri, main.clipData!!.getItemAt(0).uri)
    assertTrue(main.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    assertEquals(0, main.flags and (Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION))
    assertNull(main.data)
  }
  @Test fun ignoresRestorationAndAllowsDeliberatelySharingTheSameContentAgain() {
    val restored = Robolectric.buildActivity(Receiver::class.java, text()).create(Bundle()).get()
    assertTrue(restored.received.isEmpty())
    val first = Robolectric.buildActivity(Receiver::class.java, text()).create().get()
    val second = Robolectric.buildActivity(Receiver::class.java, text()).create().get()
    assertEquals(1, first.received.size); assertEquals(1, second.received.size)
  }
  @Test fun richPreviewThumbnailDoesNotTurnTextIntoAnImageAttachment() {
    val share = text().apply { clipData = ClipData.newRawUri("preview", Uri.parse("content://foreign/thumbnail.png")) }
    assertTrue(IncomingIntent.attachments(share).isEmpty())
    val receiver = Robolectric.buildActivity(Receiver::class.java, share).create().get()
    assertNull(shadowOf(receiver).nextStartedActivity.clipData)
    val folder = java.nio.file.Files.createTempDirectory("intake-preview").toFile()
    val inbox = IntakeInbox(folder)
    try { val entry = inbox.putText(receiver.received.single().getStringExtra(Intent.EXTRA_TEXT)!!); assertEquals("text", entry.kind) }
    finally { folder.deleteRecursively() }
  }
}
