package expo.modules.openmapxnavigationaudio

import java.util.Locale

/**
 * Decision logic for navigation speech, free of any `android.*` import so it can
 * be unit-tested on the JVM. The module class is the only part that touches
 * `TextToSpeech` and `AudioManager`.
 */

/** Result codes shared with the JavaScript contract. */
enum class SpeakOutcome(val code: String) {
  SPOKEN("spoken"),
  SKIPPED("skipped"),
  FAILED("failed"),
}

/**
 * The locales this release speaks. Anything else fails rather than falling back:
 * German guidance read by an English voice is worse than silence, which the
 * scheduled transit alert already covers.
 */
enum class SpeechLocale(val tag: String, val locale: Locale) {
  EN("en", Locale.US),
  DE("de", Locale.GERMANY);

  companion object {
    fun parse(raw: String?): SpeechLocale? =
      entries.firstOrNull { it.tag == raw?.lowercase(Locale.ROOT) }
  }
}

/**
 * Bounded, insertion-ordered set of cue identities already spoken in this
 * process.
 *
 * Duplicate suppression exists because a delayed location batch can replay a cue
 * the engine already emitted. The bound matters equally: an unbounded set in a
 * process that may live for a whole journey is a slow leak.
 */
class CueLedger(capacity: Int = DEFAULT_CAPACITY) {
  companion object {
    const val DEFAULT_CAPACITY = 256
  }

  private val capacity = maxOf(1, capacity)
  private val seen = LinkedHashSet<String>()

  val count: Int
    get() = seen.size

  fun contains(cueId: String): Boolean = seen.contains(cueId)

  /** Returns true when the cue is new and was recorded. */
  fun record(cueId: String): Boolean {
    if (!seen.add(cueId)) return false
    if (seen.size > capacity) {
      val oldest = seen.iterator().next()
      seen.remove(oldest)
    }
    return true
  }

  fun reset() = seen.clear()
}

/**
 * Tracks whether transient audio focus should be held.
 *
 * Focus is requested immediately before an utterance and abandoned as soon as
 * the queue drains, so music and podcasts duck for the length of a prompt rather
 * than the length of a journey.
 *
 * An interruption ends when focus is granted again. Android reports the end of
 * a loss only to a listener whose request is still registered, and the request
 * is abandoned on loss so nothing ducks behind a call; the next cue's own
 * request is therefore what finds out whether the interruption is over.
 *
 * Called from the module queue, the focus listener and the speech engine's
 * callbacks, so every transition is synchronised.
 */
class AudioFocusPolicy {
  var pendingUtterances: Int = 0
    private set

  var holdsFocus: Boolean = false
    private set

  var isInterrupted: Boolean = false
    private set

  /**
   * Prepares one utterance, asking `requestFocus` for focus when the queue does
   * not already hold it. Returns null when the utterance may be spoken, or the
   * outcome to report: skipped while another source still holds focus after an
   * interruption, failed when focus is refused otherwise.
   */
  @Synchronized
  fun acquireFor(requestFocus: () -> Boolean): SpeakOutcome? {
    if (!willEnqueue()) return null
    if (requestFocus()) {
      isInterrupted = false
      return null
    }
    val outcome = if (isInterrupted) SpeakOutcome.SKIPPED else SpeakOutcome.FAILED
    didStop()
    return outcome
  }

  /** True when the caller must request focus before enqueuing. */
  @Synchronized
  fun willEnqueue(): Boolean {
    pendingUtterances += 1
    if (holdsFocus) return false
    holdsFocus = true
    return true
  }

  /** True when the caller must abandon focus after this utterance ended. */
  @Synchronized
  fun didFinishUtterance(): Boolean {
    pendingUtterances = maxOf(0, pendingUtterances - 1)
    if (pendingUtterances > 0 || !holdsFocus) return false
    holdsFocus = false
    return true
  }

  /** True when the caller must abandon focus after an explicit stop. */
  @Synchronized
  fun didStop(): Boolean {
    pendingUtterances = 0
    if (!holdsFocus) return false
    holdsFocus = false
    return true
  }

  /**
   * A call or another priority source took focus. Speech is abandoned rather
   * than queued: a prompt delivered minutes late is worse than none.
   */
  @Synchronized
  fun didLoseFocus() {
    isInterrupted = true
    pendingUtterances = 0
    holdsFocus = false
  }

  @Synchronized
  fun didRegainFocus() {
    isInterrupted = false
  }
}

/**
 * Maps the contract's 0.5–2.0 multiplier onto Android's speech rate, where 1.0
 * is normal and the platform accepts roughly 0.1–4.0.
 */
fun speechRate(multiplier: Double?): Float {
  if (multiplier == null || multiplier.isNaN() || multiplier.isInfinite()) return 1.0f
  return multiplier.coerceIn(0.5, 2.0).toFloat()
}

/** Mirrors the JavaScript boundary so a bug on either side fails the same way. */
fun validateSpeechText(text: String?): Boolean {
  if (text.isNullOrEmpty() || text.length > 512) return false
  return text.none { char ->
    // Control characters either read as noise or truncate the utterance.
    (char.code < 0x20 && char.code != 0x0A) || char.code == 0x7F
  }
}

fun validateCueId(cueId: String?): Boolean = !cueId.isNullOrEmpty() && cueId.length <= 128
