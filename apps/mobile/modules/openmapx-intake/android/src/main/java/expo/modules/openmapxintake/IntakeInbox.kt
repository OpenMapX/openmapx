package expo.modules.openmapxintake

import android.util.Base64
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.util.UUID
import org.json.JSONObject

data class IntakeEntry(val id: String, val createdAtMs: Long, val kind: String, val name: String, val byteLength: Int, val format: String? = null, val errorCode: String? = null) {
  fun map(): Map<String, Any> = mutableMapOf<String, Any>("id" to id, "createdAtMs" to createdAtMs, "kind" to kind, "name" to name, "byteLength" to byteLength).also {
    if (format != null) it["format"] = format
    if (errorCode != null) it["errorCode"] = errorCode
  }
}
data class IntakeChunk(val id: String, val offset: Int, val data: String, val byteLength: Int, val eof: Boolean) {
  fun map() = mapOf("id" to id, "offset" to offset, "data" to data, "byteLength" to byteLength, "eof" to eof)
}
/** Only generated UUIDs address files. All instances share one process-wide commit lock. */
class IntakeInbox(directory: File, private val now: () -> Long = { System.currentTimeMillis() }) {
  private val root = directory.canonicalFile.also { it.mkdirs() }
  companion object { private val lock = Any() }
  private fun entryDir(id: String): File {
    if (!IntakePolicy.ids.matches(id)) throw IntakeFailure("unreadable")
    return File(root, id)
  }
  private fun entries(): List<IntakeEntry> {
    val result = mutableListOf<IntakeEntry>()
    for (dir in root.listFiles().orEmpty()) {
      if (!IntakePolicy.ids.matches(dir.name) || !dir.isDirectory || dir.canonicalFile != dir.absoluteFile) continue
      try {
        val meta = File(dir, "metadata.json")
        if (meta.length() > 4096 || meta.canonicalFile != meta.absoluteFile) throw IntakeFailure("invalid-data")
        val obj = JSONObject(meta.readText())
        val kind = obj.getString("kind")
        val keys = setOf("id", "createdAtMs", "kind", "name", "byteLength") + when (kind) { "file" -> setOf("format"); "error" -> setOf("errorCode"); "text" -> emptySet(); else -> throw IntakeFailure("invalid-data") }
        if (obj.keys().asSequence().toSet() != keys || obj.getString("id") != dir.name) throw IntakeFailure("invalid-data")
        val created = obj.getLong("createdAtMs"); val size = obj.getInt("byteLength"); val name = obj.getString("name")
        if (created < 0 || now() - created >= IntakePolicy.TTL_MS || name != IntakePolicy.name(name)) throw IntakeFailure("expired")
        val format = if (kind == "file") obj.getString("format") else null
        val code = if (kind == "error") obj.getString("errorCode") else null
        if (kind == "error") {
          if (size != 0 || code !in IntakePolicy.errors) throw IntakeFailure("invalid-data")
        } else {
          val data = File(dir, "data")
          val limit = if (kind == "text") IntakePolicy.TEXT_BYTES else IntakePolicy.FILE_BYTES
          if (size !in 1..limit || !data.isFile || data.length() != size.toLong() || data.canonicalFile != data.absoluteFile) throw IntakeFailure("invalid-data")
          if (kind == "file" && (format != IntakePolicy.format(name))) throw IntakeFailure("invalid-data")
        }
        result += IntakeEntry(dir.name, created, kind, name, size, format, code)
      } catch (_: Exception) { dir.deleteRecursively() }
    }
    val stage = File(root, "staging")
    for (file in stage.listFiles().orEmpty()) {
      val epoch = file.name.substringBefore('-').toLongOrNull() ?: continue
      if (now() - epoch > IntakePolicy.COPY_TIMEOUT_MS + 60000) file.deleteRecursively()
    }
    return result.sortedWith(compareBy<IntakeEntry> { it.createdAtMs }.thenBy { it.id })
  }
  fun list(): List<IntakeEntry> = synchronized(lock) { entries() }
  fun putText(text: String, name: String = "Shared location"): IntakeEntry {
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (text.length > IntakePolicy.TEXT_LENGTH || bytes.size > IntakePolicy.TEXT_BYTES) throw IntakeFailure("too-large")
    if (text.isBlank()) throw IntakeFailure("unsupported")
    return copy("text", IntakePolicy.name(name), null, bytes.inputStream(), IntakePolicy.TEXT_BYTES) { false }
  }
  fun putFile(name: String, source: InputStream, cancelled: () -> Boolean = { false }): IntakeEntry {
    val display = IntakePolicy.name(name)
    return copy("file", display, IntakePolicy.format(display), source, IntakePolicy.FILE_BYTES, cancelled)
  }
  private fun copy(kind: String, name: String, format: String?, source: InputStream, limit: Int, cancelled: () -> Boolean): IntakeEntry {
    val stage = File(File(root, "staging").also { it.mkdirs() }, "${now()}-${UUID.randomUUID()}")
    stage.mkdirs()
    var size = 0
    try {
      File(stage, "data").outputStream().use { output ->
        source.use { input ->
          val buffer = ByteArray(8192)
          while (true) {
            if (cancelled()) throw IntakeFailure("unreadable")
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            size += count
            if (size > limit) throw IntakeFailure("too-large")
            output.write(buffer, 0, count)
          }
        }
        output.fd.sync()
      }
      if (size == 0) throw IntakeFailure("invalid-data")
      return synchronized(lock) {
        if (cancelled()) throw IntakeFailure("unreadable")
        val current = entries().filter { it.kind != "error" }
        if (current.size >= IntakePolicy.CONTENT_ITEMS || current.sumOf { it.byteLength.toLong() } + size > IntakePolicy.INBOX_BYTES) throw IntakeFailure("inbox-full")
        val entry = IntakeEntry(UUID.randomUUID().toString(), now(), kind, name, size, format)
        File(stage, "metadata.json").writeText(JSONObject(entry.map()).toString())
        if (!stage.renameTo(entryDir(entry.id))) throw IntakeFailure("unreadable")
        entry
      }
    } finally { stage.deleteRecursively() }
  }
  fun recordError(code: String) = synchronized(lock) {
    val errors = entries().filter { it.kind == "error" }
    for (old in errors.take((errors.size - IntakePolicy.ERROR_ITEMS + 1).coerceAtLeast(0))) entryDir(old.id).deleteRecursively()
    val entry = IntakeEntry(UUID.randomUUID().toString(), now(), "error", "OpenMapX", 0, errorCode = code.takeIf { it in IntakePolicy.errors } ?: "unreadable")
    val dir = entryDir(entry.id).also { it.mkdirs() }
    File(dir, "metadata.json").writeText(JSONObject(entry.map()).toString())
  }
  fun readChunk(id: String, offset: Int): IntakeChunk = synchronized(lock) {
    if (offset < 0 || offset % IntakePolicy.CHUNK_BYTES != 0) throw IntakeFailure("unreadable")
    val dir = entryDir(id)
    val entry = entries().find { it.id == id && it.kind != "error" } ?: throw IntakeFailure("expired")
    if (offset >= entry.byteLength) throw IntakeFailure("unreadable")
    val bytes = ByteArray(minOf(IntakePolicy.CHUNK_BYTES, entry.byteLength - offset))
    RandomAccessFile(File(dir, "data"), "r").use { it.seek(offset.toLong()); it.readFully(bytes) }
    IntakeChunk(id, offset, Base64.encodeToString(bytes, Base64.NO_WRAP), bytes.size, offset + bytes.size == entry.byteLength)
  }
  fun complete(id: String) = synchronized(lock) { entryDir(id).deleteRecursively(); Unit }
}
