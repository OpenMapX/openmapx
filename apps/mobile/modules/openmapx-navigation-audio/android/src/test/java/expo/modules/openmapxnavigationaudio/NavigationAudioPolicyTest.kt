package expo.modules.openmapxnavigationaudio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CueLedgerTest {
  @Test
  fun recordsANewCueOnce() {
    val ledger = CueLedger()
    assertTrue(ledger.record("session:ground:abc:turn-1"))
    assertFalse(ledger.record("session:ground:abc:turn-1"))
    assertEquals(1, ledger.count)
  }

  @Test
  fun distinguishesCuesThatDifferOnlyBySuffix() {
    val ledger = CueLedger()
    assertTrue(ledger.record("session:ground:abc:turn-1"))
    assertTrue(ledger.record("session:ground:abc:turn-11"))
    assertEquals(2, ledger.count)
  }

  @Test
  fun evictsTheOldestEntryBeyondCapacity() {
    val ledger = CueLedger(capacity = 3)
    repeat(4) { ledger.record("cue-$it") }
    assertEquals(3, ledger.count)
    assertFalse(ledger.contains("cue-0"))
    assertTrue(ledger.contains("cue-3"))
    assertTrue(ledger.record("cue-0"))
  }

  @Test
  fun resetClearsEverything() {
    val ledger = CueLedger()
    ledger.record("a")
    ledger.reset()
    assertEquals(0, ledger.count)
    assertTrue(ledger.record("a"))
  }

  @Test
  fun capacityIsNeverLessThanOne() {
    val ledger = CueLedger(capacity = 0)
    assertTrue(ledger.record("a"))
    assertTrue(ledger.record("b"))
    assertEquals(1, ledger.count)
    assertFalse(ledger.contains("a"))
    assertTrue(ledger.contains("b"))
  }
}

class AudioFocusPolicyTest {
  @Test
  fun holdsFocusForTheQueueLifetimeWithoutUnderflow() {
    val policy = AudioFocusPolicy()
    assertTrue(policy.willEnqueue())
    assertFalse(policy.willEnqueue())
    assertTrue(policy.holdsFocus)
    assertFalse(policy.didFinishUtterance())
    assertTrue(policy.didFinishUtterance())
    assertFalse(policy.holdsFocus)
    assertFalse(policy.didFinishUtterance())
    assertEquals(0, policy.pendingUtterances)
  }

  @Test
  fun stopAbandonsFocusRegardlessOfQueueDepth() {
    val policy = AudioFocusPolicy()
    policy.willEnqueue()
    policy.willEnqueue()
    assertTrue(policy.didStop())
    assertEquals(0, policy.pendingUtterances)
    assertFalse(policy.holdsFocus)
    assertFalse(policy.didStop())
  }

  @Test
  fun refusesSpeechAfterLosingFocus() {
    val policy = AudioFocusPolicy()
    policy.willEnqueue()
    policy.didLoseFocus()
    assertFalse(policy.acceptsSpeech)
    assertFalse(policy.holdsFocus)
    assertEquals(0, policy.pendingUtterances)
    policy.didRegainFocus()
    assertTrue(policy.acceptsSpeech)
    assertTrue(policy.willEnqueue())
  }

}

class SpeechLocaleTest {
  @Test
  fun mapsSupportedLocales() {
    assertEquals("en-US", SpeechLocale.parse("en")?.locale?.toLanguageTag())
    assertEquals("de-DE", SpeechLocale.parse("de")?.locale?.toLanguageTag())
    assertEquals("de-DE", SpeechLocale.parse("DE")?.locale?.toLanguageTag())
  }

  @Test
  fun rejectsUnsupportedLocalesRatherThanFallingBack() {
    assertNull(SpeechLocale.parse("fr"))
    assertNull(SpeechLocale.parse("en-US"))
    assertNull(SpeechLocale.parse(""))
    assertNull(SpeechLocale.parse(null))
  }
}

class SpeechRateTest {
  @Test
  fun mapsAndBoundsRates() {
    val cases = listOf(
      null to 1.0f, 1.5 to 1.5f, 9.0 to 2.0f, 0.1 to 0.5f,
      Double.NaN to 1.0f, Double.POSITIVE_INFINITY to 1.0f,
    )
    for ((multiplier, expected) in cases) {
      assertEquals(expected, speechRate(multiplier), 0.0001f)
    }
  }

}

class SpeechValidationTest {
  @Test
  fun acceptsOrdinaryGuidance() {
    assertTrue(validateSpeechText("In 200 metres, turn right onto Hauptstraße."))
    assertTrue(validateSpeechText("Turn right.\nThen continue straight."))
  }

  @Test
  fun rejectsEmptyAndOversizedText() {
    assertFalse(validateSpeechText(""))
    assertFalse(validateSpeechText(null))
    assertFalse(validateSpeechText("x".repeat(513)))
    assertTrue(validateSpeechText("x".repeat(512)))
  }

  @Test
  fun rejectsControlCharacters() {
    assertFalse(validateSpeechText("Turn\u0000left"))
    assertFalse(validateSpeechText("Turn\u001Bleft"))
    assertFalse(validateSpeechText("Turn\u007Fleft"))
  }

  @Test
  fun boundsCueIdentifiers() {
    assertTrue(validateCueId("s:ground:abc:turn-1"))
    assertFalse(validateCueId(""))
    assertFalse(validateCueId(null))
    assertFalse(validateCueId("c".repeat(129)))
  }
}

class SpeakOutcomeTest {
  @Test
  fun resultCodesMatchTheJavaScriptContract() {
    assertEquals("spoken", SpeakOutcome.SPOKEN.code)
    assertEquals("skipped", SpeakOutcome.SKIPPED.code)
    assertEquals("failed", SpeakOutcome.FAILED.code)
  }
}
