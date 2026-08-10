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
  }

  @Test
  fun anEvictedCueCanBeSpokenAgain() {
    val ledger = CueLedger(capacity = 2)
    ledger.record("a")
    ledger.record("b")
    ledger.record("c")
    assertTrue(ledger.record("a"))
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
    assertEquals(1, ledger.count)
  }
}

class AudioFocusPolicyTest {
  @Test
  fun requestsFocusOnlyForTheFirstQueuedUtterance() {
    val policy = AudioFocusPolicy()
    assertTrue(policy.willEnqueue())
    assertFalse(policy.willEnqueue())
    assertTrue(policy.holdsFocus)
  }

  @Test
  fun abandonsFocusOnlyWhenTheQueueDrains() {
    val policy = AudioFocusPolicy()
    policy.willEnqueue()
    policy.willEnqueue()
    assertFalse(policy.didFinishUtterance())
    assertTrue(policy.didFinishUtterance())
    assertFalse(policy.holdsFocus)
  }

  @Test
  fun stopAbandonsFocusRegardlessOfQueueDepth() {
    val policy = AudioFocusPolicy()
    policy.willEnqueue()
    policy.willEnqueue()
    assertTrue(policy.didStop())
    assertEquals(0, policy.pendingUtterances)
    assertFalse(policy.holdsFocus)
  }

  @Test
  fun stopOnAnIdlePolicyDoesNotRequestAbandon() {
    assertFalse(AudioFocusPolicy().didStop())
  }

  @Test
  fun finishingMoreUtterancesThanQueuedDoesNotUnderflow() {
    val policy = AudioFocusPolicy()
    policy.willEnqueue()
    assertTrue(policy.didFinishUtterance())
    assertFalse(policy.didFinishUtterance())
    assertEquals(0, policy.pendingUtterances)
  }

  @Test
  fun refusesSpeechAfterLosingFocus() {
    val policy = AudioFocusPolicy()
    policy.willEnqueue()
    policy.didLoseFocus()
    assertFalse(policy.acceptsSpeech)
    assertFalse(policy.holdsFocus)
    assertEquals(0, policy.pendingUtterances)
  }

  @Test
  fun acceptsSpeechAgainAfterRegainingFocus() {
    val policy = AudioFocusPolicy()
    policy.didLoseFocus()
    policy.didRegainFocus()
    assertTrue(policy.acceptsSpeech)
    assertTrue(policy.willEnqueue())
  }
}

class SpeechLocaleTest {
  @Test
  fun mapsSupportedLocales() {
    assertEquals(SpeechLocale.EN, SpeechLocale.parse("en"))
    assertEquals(SpeechLocale.DE, SpeechLocale.parse("de"))
  }

  @Test
  fun isCaseInsensitive() {
    assertEquals(SpeechLocale.DE, SpeechLocale.parse("DE"))
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
  fun defaultsToNormalRate() {
    assertEquals(1.0f, speechRate(null), 0.0001f)
  }

  @Test
  fun passesAnInRangeMultiplierThrough() {
    assertEquals(1.5f, speechRate(1.5), 0.0001f)
  }

  @Test
  fun clampsAnOutOfContractMultiplier() {
    assertEquals(2.0f, speechRate(9.0), 0.0001f)
    assertEquals(0.5f, speechRate(0.1), 0.0001f)
  }

  @Test
  fun fallsBackForANonFiniteMultiplier() {
    assertEquals(1.0f, speechRate(Double.NaN), 0.0001f)
    assertEquals(1.0f, speechRate(Double.POSITIVE_INFINITY), 0.0001f)
  }
}

class SpeechValidationTest {
  @Test
  fun acceptsOrdinaryGuidance() {
    assertTrue(validateSpeechText("In 200 metres, turn right onto Hauptstraße."))
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
  fun allowsANewlineBetweenSentences() {
    assertTrue(validateSpeechText("Turn right.\nThen continue straight."))
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
