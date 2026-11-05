package expo.modules.openmapxintake

import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileDescriptor
import java.io.FileInputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class ProviderReaderTest {
  @get:Rule val temp = TemporaryFolder()
  // Robolectric implements createPipe using a temp file and has no Os.poll/read shadow.
  // Exercise the real descriptor + store with an injected polling adapter; actual pipes are a device gate.
  private fun io(hung: Boolean = false) = object : ProviderReader.Io {
    override fun configure(fd: FileDescriptor) {}
    override fun ready(fd: FileDescriptor): Boolean { if (hung) Thread.sleep(5); return !hung }
    override fun read(fd: FileDescriptor, data: ByteArray, offset: Int, length: Int): Int = FileInputStream(fd).read(data, offset, length).let { if (it < 0) 0 else it }
  }
  @Test fun acceptsReadableDescriptor() {
    val pipe = ParcelFileDescriptor.createPipe()
    ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { it.write("<gpx/>".toByteArray()) }
    val inbox = IntakeInbox(temp.newFolder())
    val entry = ProviderReader.copy("route.gpx", pipe[0], inbox, io = io())
    assertEquals(6, entry.byteLength)
  }
  @Test fun deadlineClosesHungPipeAndDoesNotCommit() {
    val pipe = ParcelFileDescriptor.createPipe()
    val inbox = IntakeInbox(temp.newFolder())
    val executor = Executors.newSingleThreadExecutor()
    try {
      val result = executor.submit<String> {
        try { ProviderReader.copy("route.gpx", pipe[0], inbox, 50, io(true)); "unexpected" }
        catch (e: IntakeFailure) { e.code }
      }
      assertEquals("unreadable", result.get(3, TimeUnit.SECONDS))
      assertTrue(inbox.list().isEmpty())
      assertFalse(pipe[0].fileDescriptor.valid())
    } finally { pipe[1].close(); executor.shutdownNow() }
  }
}
