package expo.modules.openmapxintake

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Pre-JS capture. No Activity, sender URI, or content survives in the event payload. */
object IntakeIngress {
  val listeners = CopyOnWriteArraySet<() -> Unit>()
  private val workers = ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, ArrayBlockingQueue<Runnable>(8))
  private val deadlines = Executors.newSingleThreadScheduledExecutor()
  private val overflowWorker = Executors.newSingleThreadExecutor()
  private val overflowPending = AtomicBoolean(false)
  fun inbox(context: Context) = IntakeInbox(File(context.noBackupFilesDir, "openmapx-intake"))
  internal fun changed() { listeners.forEach { try { it() } catch (_: Exception) {} } }
  fun capture(context: Context, intent: Intent) {
    val app = context.applicationContext
    // Copy while grants are attached to the receiving Activity. The queue is deliberately bounded.
    try { workers.execute { try { ingest(app, intent) } catch (_: Exception) { changed() } } }
    catch (_: Exception) { reportError(app, "inbox-full") }
  }
  internal fun reportError(context: Context, code: String) {
    // The Activity thread can report an error but never does quota/filesystem work.
    val app = context.applicationContext
    if (overflowPending.compareAndSet(false, true)) overflowWorker.execute {
      try { inbox(app).recordError(code) } catch (_: Exception) {}
      finally { overflowPending.set(false); changed() }
    }
  }
  @Suppress("DEPRECATION")
  private fun ingest(context: Context, intent: Intent) {
    val inbox = inbox(context)
    val cancelled = AtomicBoolean(false)
    val signal = CancellationSignal()
    val descriptor = AtomicReference<ParcelFileDescriptor?>(null)
    val started = System.nanoTime()
    val deadline = deadlines.schedule({ cancelled.set(true); try { descriptor.get()?.close() } catch (_: Exception) {}; try { signal.cancel() } catch (_: Exception) {} }, IntakePolicy.COPY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    try {
      val uris = IncomingIntent.attachments(intent)
      if (uris.isEmpty()) {
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT) ?: throw IntakeFailure("unsupported")
        if (text.length > IntakePolicy.TEXT_LENGTH) throw IntakeFailure("too-large")
        if (cancelled.get()) throw IntakeFailure("unreadable")
        inbox.putText(text.toString())
      } else {
        val manager = context.packageManager
        val ownAuthorities = manager.getPackageInfo(context.packageName, PackageManager.GET_PROVIDERS).providers.orEmpty().flatMap { it.authority.orEmpty().split(';') }.toSet()
        // Preflight every attachment before committing any; mixed unsupported shares are rejected.
        val files = uris.map { uri ->
          val resolved = manager.resolveContentProvider(uri.authority.orEmpty(), 0)
          if (!IncomingIntent.isForeignContent(uri, ownAuthorities, resolved?.applicationInfo?.uid, android.os.Process.myUid())) throw IntakeFailure("unsupported")
          val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null, signal)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
          } ?: throw IntakeFailure("unreadable")
          if (name.length > 1024) throw IntakeFailure("unsupported")
          val display = IntakePolicy.name(name)
          IntakePolicy.format(display)
          uri to display
        }
        for ((uri, name) in files) {
          if (cancelled.get()) throw IntakeFailure("unreadable")
          val fd = context.contentResolver.openFileDescriptor(uri, "r", signal) ?: throw IntakeFailure("unreadable")
          descriptor.set(fd)
          val remaining = IntakePolicy.COPY_TIMEOUT_MS - TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
          if (cancelled.get() || remaining <= 0) { fd.close(); throw IntakeFailure("unreadable") }
          ProviderReader.copy(name, fd, inbox, remaining)
          descriptor.set(null)
        }
      }
    } catch (e: Exception) { try { inbox.recordError((e as? IntakeFailure)?.code ?: "unreadable") } catch (_: Exception) {} }
    finally { deadline.cancel(false); try { descriptor.get()?.close() } catch (_: Exception) {}; changed() }
  }
}
