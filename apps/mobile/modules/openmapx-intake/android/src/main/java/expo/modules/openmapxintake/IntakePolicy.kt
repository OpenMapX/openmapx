package expo.modules.openmapxintake

import java.util.Locale

class IntakeFailure(val code: String) : Exception(code)
object IntakePolicy {
  const val FILE_BYTES = 5 * 1024 * 1024
  const val TEXT_BYTES = 8192
  const val TEXT_LENGTH = 4096
  const val CHUNK_BYTES = 24576
  const val INBOX_BYTES = 20 * 1024 * 1024
  const val CONTENT_ITEMS = 8
  const val ERROR_ITEMS = 2
  const val TTL_MS = 24 * 60 * 60 * 1000L
  const val COPY_TIMEOUT_MS = 10000L
  val ids = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
  val errors = setOf("unsupported", "too-large", "too-many", "inbox-full", "unreadable", "expired", "unavailable", "invalid-data")
  fun name(raw: String) = raw.substringAfterLast('/').substringAfterLast('\\').filter { it.code >= 32 && it.code !in 0x202A..0x202E && it.code !in 0x2066..0x2069 }.take(128).trim()
  fun format(name: String): String = when (name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
    "gpx" -> "gpx"; "geojson" -> "geojson"; "kml" -> "kml"
    else -> throw IntakeFailure("unsupported")
  }
}
