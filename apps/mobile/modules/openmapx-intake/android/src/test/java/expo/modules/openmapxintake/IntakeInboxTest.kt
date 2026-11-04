package expo.modules.openmapxintake

import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.Executors
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class IntakeInboxTest {
  @get:Rule val temp = TemporaryFolder()
  private var clock = 1_700_000_000_000L
  private fun inbox() = IntakeInbox(temp.newFolder(), { clock })
  private fun failure(code: String, work: () -> Unit) {
    try { work(); fail("expected $code") } catch (e: IntakeFailure) { assertEquals(code, e.code) }
  }
  @Test fun textSurvivesReopenAndAcknowledgementIsIdempotent() {
    val dir = temp.newFolder()
    val store = IntakeInbox(dir) { clock }
    val entry = store.putText("Bahnhofstraße München")
    assertEquals("text", entry.kind)
    val reopened = IntakeInbox(dir) { clock }
    assertEquals(entry.id, reopened.list().single().id)
    val chunk = reopened.readChunk(entry.id, 0)
    assertTrue(chunk.eof)
    assertArrayEquals("Bahnhofstraße München".toByteArray(), android.util.Base64.decode(chunk.data, android.util.Base64.DEFAULT))
    reopened.complete(entry.id); reopened.complete(entry.id)
    assertTrue(reopened.list().isEmpty())
  }
  @Test fun rejectsUnknownExtensionAndOversizedActualStream() {
    val store = inbox()
    failure("unsupported") { store.putFile("private.json", ByteArrayInputStream("{}".toByteArray())) }
    failure("too-large") { store.putFile("route.gpx", ByteArrayInputStream(ByteArray(IntakePolicy.FILE_BYTES + 1))) }
    assertTrue(store.list().isEmpty())
  }
  @Test fun expiryRemovesDataAndOpaqueIdsCannotReadOtherFiles() {
    val store = inbox(); val item = store.putText("Station")
    failure("unreadable") { store.readChunk("../private", 0) }
    failure("unreadable") { store.readChunk(item.id, 1) }
    clock += IntakePolicy.TTL_MS + 1
    assertTrue(store.list().isEmpty())
    failure("expired") { store.readChunk(item.id, 0) }
  }
  @Test fun fullInboxStillReportsASeparateBoundedError() {
    val store = inbox()
    repeat(8) { store.putText("Station $it") }
    failure("inbox-full") { store.putText("Ninth item") }
    repeat(5) { store.recordError("inbox-full") }
    assertEquals(8, store.list().count { it.kind != "error" })
    assertEquals(2, store.list().count { it.kind == "error" })
  }
  @Test fun concurrentCommitsCannotExceedQuota() {
    val dir = temp.newFolder(); val pool = Executors.newFixedThreadPool(4)
    try {
      val jobs = (0..15).map { n -> pool.submit<Boolean> {
        try { IntakeInbox(dir) { clock }.putText("Station $n"); true } catch (_: IntakeFailure) { false }
      } }
      assertEquals(8, jobs.count { it.get() })
      assertEquals(8, IntakeInbox(dir) { clock }.list().size)
    } finally { pool.shutdownNow() }
  }
  @Test fun chunksAreStatelessAndDoNotExceedTheWireLimit() {
    val store = inbox(); val data = ByteArray(50000) { (it % 127).toByte() }
    val item = store.putFile("route.geojson", ByteArrayInputStream(data))
    val first = store.readChunk(item.id, 0); val second = store.readChunk(item.id, IntakePolicy.CHUNK_BYTES)
    assertEquals(24576, first.byteLength); assertFalse(first.eof)
    assertEquals(24576, second.byteLength); assertFalse(second.eof)
    val last = store.readChunk(item.id, 49152); assertTrue(last.eof)
    assertEquals(848, last.byteLength)
  }
  @Test fun cancellationNeverCommitsAPartialFile() {
    val store = inbox()
    failure("unreadable") { store.putFile("route.kml", ByteArrayInputStream(ByteArray(20))) { true } }
    assertTrue(store.list().isEmpty())
  }
}
