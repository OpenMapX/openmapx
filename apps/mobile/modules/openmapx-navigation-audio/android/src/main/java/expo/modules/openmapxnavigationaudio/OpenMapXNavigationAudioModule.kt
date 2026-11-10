package expo.modules.openmapxnavigationaudio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The Android half of the navigation audio module.
 *
 * Everything decidable without the platform lives in `NavigationAudioPolicy.kt`
 * and is unit-tested there. This file is the thin part: a lazily-initialised
 * `TextToSpeech`, navigation-guidance audio attributes, and transient
 * may-duck focus so guidance never talks over a call.
 */
class OpenMapXNavigationAudioModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val ledger = CueLedger()
  private val focusPolicy = AudioFocusPolicy()

  private var textToSpeech: TextToSpeech? = null
  @Volatile private var initialized = false
  @Volatile private var initializationFailed = false
  /** Released by the engine's initialisation callback, whatever its status. */
  private var engineReady = CountDownLatch(1)
  private var speaking = false
  private var lastResultCode: String? = null
  private var focusRequest: AudioFocusRequest? = null

  private val audioAttributes: AudioAttributes by lazy {
    AudioAttributes.Builder()
      // Tells the system this is turn-by-turn guidance, which is what makes
      // Android duck media and route to a car speaker correctly.
      .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
  }

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        textToSpeech?.stop()
        focusPolicy.didLoseFocus()
        abandonFocus()
      }
      AudioManager.AUDIOFOCUS_GAIN -> focusPolicy.didRegainFocus()
      else -> Unit
    }
  }

  override fun definition() = ModuleDefinition {
    Name("OpenMapXNavigationAudio")

    // Binding to the platform engine takes a moment; starting it here means the
    // first cue of a trip rarely has to wait for it.
    OnCreate { runCatching { ensureEngine() } }

    OnDestroy {
      textToSpeech?.stop()
      textToSpeech?.shutdown()
      textToSpeech = null
      abandonFocus()
    }

    AsyncFunction("speak") { request: SpeakRequestRecord -> speak(request) }

    AsyncFunction("stop") { stopSpeaking() }

    AsyncFunction("getStatus") {
      mapOf(
        "initialized" to initialized,
        "speaking" to speaking,
        "localeAvailable" to SpeechLocale.entries.all { isLanguageAvailable(it) },
        "lastResultCode" to lastResultCode,
      )
    }
  }

  private fun speak(request: SpeakRequestRecord): String {
    if (!validateCueId(request.cueId) || !validateSpeechText(request.text)) {
      return finish(SpeakOutcome.FAILED)
    }
    val locale = SpeechLocale.parse(request.locale) ?: return finish(SpeakOutcome.FAILED)

    val engine = ensureEngine() ?: return finish(SpeakOutcome.FAILED)
    // `TextToSpeech` binds to the engine asynchronously, and until it has, every
    // query answers "not bound". This runs off the main thread, where the
    // initialisation callback is delivered, so waiting here cannot deadlock.
    if (!initialized && !engineReady.await(ENGINE_INIT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
      return finish(SpeakOutcome.FAILED)
    }
    if (!initialized || !isLanguageAvailable(locale)) {
      return finish(SpeakOutcome.FAILED)
    }
    // A replayed cue is treated as already handled, never repeated. Recorded
    // only once the engine can speak, so a cold engine does not swallow it.
    if (!ledger.record(request.cueId)) return finish(SpeakOutcome.SKIPPED)

    // After an interruption this request is what learns whether it has ended.
    focusPolicy.acquireFor(::requestFocus)?.let { return finish(it) }

    engine.language = locale.locale
    engine.setSpeechRate(speechRate(request.rate))
    val params = Bundle().apply {
      putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, request.cueId)
    }
    speaking = true
    val queued = engine.speak(request.text, TextToSpeech.QUEUE_ADD, params, request.cueId)
    if (queued != TextToSpeech.SUCCESS) {
      speaking = false
      if (focusPolicy.didFinishUtterance()) abandonFocus()
      return finish(SpeakOutcome.FAILED)
    }
    return finish(SpeakOutcome.SPOKEN)
  }

  private fun stopSpeaking() {
    textToSpeech?.stop()
    speaking = false
    if (focusPolicy.didStop()) abandonFocus()
  }

  @Synchronized
  private fun ensureEngine(): TextToSpeech? {
    if (initializationFailed) return null
    textToSpeech?.let { return it }
    val ready = CountDownLatch(1)
    engineReady = ready
    val engine = TextToSpeech(context) { status ->
      initialized = status == TextToSpeech.SUCCESS
      initializationFailed = !initialized
      ready.countDown()
    }
    engine.setAudioAttributes(audioAttributes)
    engine.setOnUtteranceProgressListener(
      object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit

        override fun onDone(utteranceId: String?) {
          speaking = false
          if (focusPolicy.didFinishUtterance()) abandonFocus()
        }

        @Deprecated("Required by the platform base class", ReplaceWith("onError(utteranceId, -1)"))
        override fun onError(utteranceId: String?) = onError(utteranceId, -1)

        override fun onError(utteranceId: String?, errorCode: Int) {
          speaking = false
          lastResultCode = SpeakOutcome.FAILED.code
          if (focusPolicy.didFinishUtterance()) abandonFocus()
        }
      }
    )
    textToSpeech = engine
    return engine
  }

  private fun isLanguageAvailable(locale: SpeechLocale): Boolean {
    val engine = textToSpeech ?: return false
    return when (engine.isLanguageAvailable(locale.locale)) {
      TextToSpeech.LANG_AVAILABLE,
      TextToSpeech.LANG_COUNTRY_AVAILABLE,
      TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE -> true
      else -> false
    }
  }

  private fun requestFocus(): Boolean {
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(audioAttributes)
      .setWillPauseWhenDucked(false)
      .setOnAudioFocusChangeListener(focusListener)
      .build()
    focusRequest = request
    return audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocus() {
    focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
    focusRequest = null
  }

  private fun finish(outcome: SpeakOutcome): String {
    lastResultCode = outcome.code
    return outcome.code
  }
}

/**
 * Expo record for the bounded speak contract. Unknown keys are dropped by the
 * Records machinery, so nothing beyond these four fields can reach native code.
 */
class SpeakRequestRecord : Record {
  @Field var cueId: String = ""

  @Field var text: String = ""

  @Field var locale: String = "en"

  @Field var rate: Double? = null
}

/** How long a cue waits for a cold engine before it is reported as failed. */
private const val ENGINE_INIT_TIMEOUT_MS = 3_000L
