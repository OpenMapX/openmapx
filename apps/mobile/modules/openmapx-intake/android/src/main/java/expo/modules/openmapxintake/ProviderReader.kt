package expo.modules.openmapxintake

import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import java.io.InputStream
import java.io.FileDescriptor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Poll + nonblocking reads: a provider's pipe cannot pin an ingestion worker forever. */
object ProviderReader {
  private val watchdog = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "OpenMapX-intake-deadline").apply { isDaemon = true } }
  interface Io {
    fun configure(fd: FileDescriptor)
    fun ready(fd: FileDescriptor): Boolean
    fun read(fd: FileDescriptor, data: ByteArray, offset: Int, length: Int): Int
  }
  private val platformIo = object : Io {
    override fun configure(fd: FileDescriptor) { Os.fcntlInt(fd, OsConstants.F_SETFL, Os.fcntlInt(fd, OsConstants.F_GETFL, 0) or OsConstants.O_NONBLOCK) }
    override fun ready(fd: FileDescriptor): Boolean {
      val poll = StructPollfd().apply { this.fd = fd; events = OsConstants.POLLIN.toShort() }
      return Os.poll(arrayOf(poll), 50) > 0
    }
    override fun read(fd: FileDescriptor, data: ByteArray, offset: Int, length: Int) = Os.read(fd, data, offset, length)
  }
  fun copy(name: String, descriptor: ParcelFileDescriptor, inbox: IntakeInbox, timeoutMs: Long = IntakePolicy.COPY_TIMEOUT_MS, io: Io = platformIo): IntakeEntry {
    val expired = AtomicBoolean(false)
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    val task = watchdog.schedule({ expired.set(true); try { descriptor.close() } catch (_: Exception) {} }, timeoutMs, TimeUnit.MILLISECONDS)
    try {
      val fd = descriptor.fileDescriptor
      io.configure(fd)
      val source = object : InputStream() {
        override fun read(): Int { val data = ByteArray(1); return if (read(data, 0, 1) < 0) -1 else data[0].toInt() and 255 }
        override fun read(data: ByteArray, offset: Int, length: Int): Int {
          while (!expired.get() && System.nanoTime() < deadline) {
            if (!io.ready(fd)) continue
            try { val count = io.read(fd, data, offset, length); return if (count == 0) -1 else count }
            catch (e: ErrnoException) { if (e.errno != OsConstants.EAGAIN && e.errno != OsConstants.EINTR) throw e }
          }
          throw IntakeFailure("unreadable")
        }
        override fun close() { descriptor.close() }
      }
      return inbox.putFile(name, source) { expired.get() || System.nanoTime() >= deadline }
    } catch (e: IntakeFailure) { throw e }
    catch (_: Exception) { throw IntakeFailure("unreadable") }
    finally { task.cancel(false); try { descriptor.close() } catch (_: Exception) {} }
  }
}
