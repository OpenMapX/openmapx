import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { AccessibilityInfo, Platform } from "react-native";
import type { MobileLocale } from "../../config/nativeCopy";
import { getNavigationAudio } from "../audio/navigationAudioModule";
import { answerCommand } from "../bridge/answerCommand";
import { createShellBridge, type ShellBridge } from "../bridge/createShellBridge";
import type { MobileRuntimeConfig } from "../config/runtimeConfig";
import { IntakeController } from "../intake/IntakeController";
import {
  createNativeIntakePort,
  NativeIntakeError,
  type NativeIntakePort,
} from "../intake/nativeIntakeModule";
import { createLocationDriver } from "../location/createLocationDriver";
import {
  createForegroundNavigation,
  type ForegroundNavigation,
} from "../navigation/createForegroundNavigation";
import {
  createPermissionPrompter,
  type PermissionPrompter,
} from "../permissions/PermissionPrompts";
import { createUserIntentGate, type UserIntentGate } from "../voice/userIntentGate";
import { VoiceInputController } from "../voice/VoiceInputController";
import { createShellServices } from "./shellServices";

/** What a shell without native navigation reports. */
const NO_NAVIGATION = {
  groundNavigation: false,
  transitNavigation: false,
  backgroundLocation: false,
  localNotifications: false,
  speech: false,
};

export interface ShellRuntimeOptions {
  config: MobileRuntimeConfig;
  locale: MobileLocale;
  /** Runs a script in the WebView's current document, if one is mounted. */
  inject(script: string): void;
  isAppActive(): boolean;
  /** Told when guidance starts, or stops while its session remains. */
  onNavigatingChanged(navigating: boolean): void;
  /** Told once whenever a session ends, whoever ended it. */
  onSessionEnded(): void;
}

export interface ShellRuntime {
  shell: ShellBridge;
  /** The foreground navigation graph, or null when this build or device has none. */
  navigation: Promise<ForegroundNavigation | null>;
  voice: VoiceInputController;
  voiceIntent: UserIntentGate;
  prompter: PermissionPrompter;
  intakePort: NativeIntakePort;
  /** Stops listening, cancels voice input and disposes the navigation graph. */
  dispose(): void;
  isDisposed(): boolean;
}

/**
 * Composes everything the visible shell runs beside the WebView: the bridge,
 * voice input, native intake and the foreground navigation graph.
 *
 * Commands from the page go to the composition that owns them. Intake and
 * voice answer outside the navigation queue, so a long navigation command never
 * holds up the microphone or the inbox. Navigation commands go through the
 * coordinator's queue, and the one-shot location, settings and sign-in requests
 * are answered beside it. A build without navigation (the feasibility probe)
 * answers only those.
 */
export function createShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const { config, locale } = options;
  const services = createShellServices({ config, isAppActive: options.isAppActive });
  const prompter = createPermissionPrompter({
    locale,
    requestBackgroundAccess: () => createLocationDriver().requestBackgroundPermission(),
  });
  const intakePort = createNativeIntakePort();
  const voiceIntent = createUserIntentGate();

  // With a screen reader on, activation arrives as an accessibility action
  // rather than a touch, so the voice gate needs to know.
  let disposed = false;
  void AccessibilityInfo.isScreenReaderEnabled()
    .then((enabled) => {
      if (!disposed) voiceIntent.setScreenReader(enabled);
    })
    .catch(() => undefined);
  const screenReader = AccessibilityInfo.addEventListener("screenReaderChanged", (enabled) =>
    voiceIntent.setScreenReader(enabled),
  );

  let navigation: Promise<ForegroundNavigation | null> = Promise.resolve(null);
  const voice = new VoiceInputController({
    module: ExpoSpeechRecognitionModule,
    platform: Platform.OS,
    api: Number(Platform.Version),
    audio: getNavigationAudio(),
    active: options.isAppActive,
    channel: () => (shell.registry.handshake() ? (shell.registry.current()?.nonce ?? null) : null),
    emit: (event) => shell.bridge.send("voice.event", event),
  });
  const shell: ShellBridge = createShellBridge({
    webOrigin: config.webOrigin,
    inject: options.inject,
    dispatch: async (message) => {
      if (message.type.startsWith("intake.")) {
        await intake.dispatch(message);
        return;
      }
      if (message.type === "voice.probe") {
        shell.bridge.send(
          "voice.availability",
          { available: voice.isAvailable() },
          { forMessageId: message.messageId },
        );
        return;
      }
      if (message.type === "voice.start") {
        // The microphone starts only after a touch the shell itself saw
        // (see userIntentGate), never on the page's word alone.
        if (!voiceIntent.admit()) {
          shell.bridge.send("voice.event", {
            requestId: message.payload.requestId,
            state: "error",
            error: "generic",
          });
          return;
        }
        void voice.start(message.payload.requestId, message.payload.locale);
        return;
      }
      if (message.type === "voice.stop") {
        voice.stop(message.payload.requestId);
        return;
      }
      if (message.type === "voice.cancel") {
        voice.cancel(message.payload.requestId);
        return;
      }
      const composedNavigation = await navigation;
      if (composedNavigation) {
        await composedNavigation.dispatch(message);
        return;
      }
      await answerCommand(message, services.auxiliary, (type, payload, sendOptions) =>
        shell.bridge.send(type, payload, sendOptions),
      );
    },
    capabilities: async () => ({
      ...((await navigation)?.capabilities() ?? NO_NAVIGATION),
      nativeIntake: await intakePort.available(),
    }),
    permission: () => services.permission(),
    activeSession: async () => (await navigation)?.activeSession() ?? null,
    reportInvalidSend: (type) => {
      void navigation.then((composed) => composed?.reportInvalidSend(type));
    },
  });
  if (!config.feasibilityMode) {
    navigation = createForegroundNavigation({
      apiOrigin: config.apiOrigin,
      locale,
      send: (type, payload, sendOptions) => shell.bridge.send(type, payload, sendOptions),
      permissionUi: prompter.ui,
      isAppActive: options.isAppActive,
      auxiliary: services.auxiliary,
      onNavigatingChanged: options.onNavigatingChanged,
      onSessionEnded: options.onSessionEnded,
    }).catch(() => null);
  }
  const intake = new IntakeController({
    port: intakePort,
    scheme: config.scheme,
    currentNonce: () => shell.registry.current()?.nonce,
    send: (type, payload, sendOptions) => shell.bridge.send(type, payload, sendOptions),
    canApply: async () => {
      const runtime = await navigation;
      if (runtime === null) {
        if (config.feasibilityMode) return true;
        throw new NativeIntakeError("navigation-unavailable");
      }
      try {
        return (await runtime.activeSession()) === null;
      } catch {
        throw new NativeIntakeError("navigation-unavailable");
      }
    },
  });

  return {
    shell,
    navigation,
    voice,
    voiceIntent,
    prompter,
    intakePort,
    dispose() {
      if (disposed) return;
      disposed = true;
      screenReader.remove();
      voice.cancel();
      void navigation.then((composed) => composed?.dispose());
    },
    isDisposed: () => disposed,
  };
}
