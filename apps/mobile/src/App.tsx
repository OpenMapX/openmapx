import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  Alert,
  Linking,
  Platform,
  StatusBar,
  StyleSheet,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { getNavigationAudio } from "./audio/navigationAudioModule";
import { answerCommand } from "./bridge/answerCommand";
import { createShellBridge, type ShellBridge } from "./bridge/createShellBridge";
import { buildChannelBootstrapScript } from "./bridge/outboundScript";
import { getRuntimeConfig, type MobileRuntimeConfig } from "./config/runtimeConfig";
import { useConnectivity } from "./connectivity/useConnectivity";
import { IntakeController } from "./intake/IntakeController";
import { createNativeIntakePort, NativeIntakeError } from "./intake/nativeIntakeModule";
import { createNavigationRecoveryController } from "./lifecycle/createNavigationRecoveryController";
import { useAppVisibility } from "./lifecycle/useAppLifecycle";
import { buildWebVisibilityScript } from "./lifecycle/webVisibility";
import type { DeepLinkIntent } from "./links/deepLinkIntent";
import { useIncomingLinks } from "./links/useIncomingLinks";
import { createLocationDriver } from "./location/createLocationDriver";
import {
  createForegroundNavigation,
  type ForegroundNavigation,
} from "./navigation/createForegroundNavigation";
import { surfaceCopy } from "./navigation/surfaces/surfaceModel";
import { createPermissionPrompter, PermissionPrompts } from "./permissions/PermissionPrompts";
import { FeasibilityOverlay } from "./shell/FeasibilityOverlay";
import { NativeRecoveryOverlay } from "./shell/NativeRecoveryOverlay";
import { type NativePalette, useNativePalette } from "./shell/nativeTheme";
import { classifyNavigation } from "./shell/originPolicy";
import { LoadingOverlay } from "./shell/ShellOverlays";
import type { ShellAction } from "./shell/ShellState";
import { deviceMobileLocale } from "./shell/shellCopy";
import { INITIAL_SHELL, shellReducer } from "./shell/shellReducer";
import { createShellServices } from "./shell/shellServices";
import { useHardwareBack } from "./shell/useHardwareBack";
import { createUserIntentGate } from "./voice/userIntentGate";
import { VoiceInputController } from "./voice/VoiceInputController";

/**
 * The entire visible product is the web UI inside one WebView pointed at the
 * origin compiled into this binary. Native UI exists only for the states the
 * WebView cannot render itself: the first load, a failed load, a session that
 * outlived its process, and a fatally misconfigured build.
 */

/** What a shell without native navigation reports. */
const NO_NAVIGATION = {
  groundNavigation: false,
  transitNavigation: false,
  backgroundLocation: false,
  localNotifications: false,
  speech: false,
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  webView: { flex: 1 },
});

/**
 * The app draws edge to edge, so the status bar sits over whatever is behind
 * it: a native screen in the system appearance, or the page, which follows the
 * same appearance by default. Its icons have to contrast with that.
 */
function ShellStatusBar({ palette }: { palette: NativePalette }): ReactElement {
  return (
    <StatusBar
      barStyle={palette.scheme === "dark" ? "light-content" : "dark-content"}
      backgroundColor="transparent"
      translucent
    />
  );
}

function ProductShell({ config }: { config: MobileRuntimeConfig }): ReactElement {
  const locale = useMemo(() => deviceMobileLocale(), []);
  const palette = useNativePalette();
  const [shellState, dispatchShell] = useReducer(shellReducer, INITIAL_SHELL);
  // Remounting the WebView is the only reliable way to retry a load that failed
  // before any document existed; `reload()` on a blank view is a no-op.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const visibility = useAppVisibility();
  const visibilityRef = useRef(visibility);
  visibilityRef.current = visibility;
  const connectivity = useConnectivity();

  const webViewRef = useRef<WebView>(null);
  const [voiceIntent] = useState(() => createUserIntentGate());
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (mounted) voiceIntent.setScreenReader(enabled);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("screenReaderChanged", (enabled) =>
      voiceIntent.setScreenReader(enabled),
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [voiceIntent]);
  const webSource = useMemo(() => ({ uri: new URL(config.webOrigin).href }), [config.webOrigin]);
  const handleNavigationStateChange = useHardwareBack(webViewRef);
  useEffect(() => {
    webViewRef.current?.injectJavaScript(buildWebVisibilityScript(visibility));
  }, [visibility]);
  const services = useMemo(
    () =>
      createShellServices({
        config,
        isAppActive: () => visibilityRef.current === "active",
      }),
    [config],
  );
  const prompter = useMemo(
    () =>
      createPermissionPrompter({
        locale,
        requestBackgroundAccess: () => createLocationDriver().requestBackgroundPermission(),
      }),
    [locale],
  );
  // Shell states follow guidance starting and ending; repeated reports of the
  // same state are dropped so a stream of snapshots is not a stream of renders.
  const navigatingRef = useRef(false);
  const setNavigating = useCallback((navigating: boolean) => {
    if (navigatingRef.current === navigating) return;
    navigatingRef.current = navigating;
    dispatchShell({ type: navigating ? "session-started" : "session-ended" });
  }, []);
  const intakePort = useMemo(() => createNativeIntakePort(), []);
  const { shell, navigation, voice } = useMemo(() => {
    let intake: IntakeController;
    let navigation: Promise<ForegroundNavigation | null> = Promise.resolve(null);
    const voice = new VoiceInputController({
      module: ExpoSpeechRecognitionModule,
      platform: Platform.OS,
      api: Number(Platform.Version),
      audio: getNavigationAudio(),
      active: () => visibilityRef.current === "active",
      channel: () =>
        composed.registry.handshake() ? (composed.registry.current()?.nonce ?? null) : null,
      emit: (event) => composed.bridge.send("voice.event", event),
    });
    const composed: ShellBridge = createShellBridge({
      webOrigin: config.webOrigin,
      inject: (script) => webViewRef.current?.injectJavaScript(script),
      // Navigation commands go through the coordinator's queue; the
      // composition answers the one-shot location, settings and sign-in
      // requests beside it. A build without it (the feasibility probe) answers
      // only those.
      dispatch: async (message) => {
        if (message.type.startsWith("intake.")) {
          await intake.dispatch(message);
          return;
        }
        if (message.type === "voice.probe") {
          composed.bridge.send(
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
            composed.bridge.send("voice.event", {
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
        await answerCommand(message, services.auxiliary, (type, payload, options) =>
          composed.bridge.send(type, payload, options),
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
        send: (type, payload, options) => composed.bridge.send(type, payload, options),
        permissionUi: prompter.ui,
        isAppActive: () => visibilityRef.current === "active",
        auxiliary: services.auxiliary,
        onNavigatingChanged: setNavigating,
      }).catch(() => null);
    }
    intake = new IntakeController({
      port: intakePort,
      scheme: config.scheme,
      currentNonce: () => composed.registry.current()?.nonce,
      send: (type, payload) => composed.bridge.send(type, payload),
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
    return { shell: composed, navigation, intake, voice };
  }, [config, locale, prompter, services, setNavigating, intakePort, voiceIntent]);
  useEffect(() => {
    if (visibility !== "active") voice.suspend();
  }, [visibility, voice]);
  const deliverLink = useCallback(
    (intent: DeepLinkIntent) => {
      shell.bridge.send("deep-link.open", intent);
    },
    [shell],
  );
  const requestNativeEnd = useCallback(
    (sessionId: string) => {
      void navigation
        .then(async (composed) => {
          const copy = surfaceCopy[locale];
          if (!composed) {
            Alert.alert(copy.unavailable);
            return;
          }
          if ((await composed.activeSession())?.sessionId !== sessionId) {
            Alert.alert(copy.ended);
            return;
          }
          Alert.alert(copy.end, copy.confirm, [
            { text: copy.cancel, style: "cancel" },
            {
              text: copy.end,
              style: "destructive",
              onPress: () => {
                void composed.coordinator
                  .stopFromSurface(sessionId)
                  .then((stopped) => {
                    if (stopped) setNavigating(false);
                  })
                  .catch(() => undefined);
              },
            },
          ]);
        })
        .catch(() => Alert.alert(surfaceCopy[locale].unavailable));
    },
    [navigation, locale, setNavigating],
  );
  const incomingLinks = useIncomingLinks(config, deliverLink, requestNativeEnd);
  useEffect(
    () => () => {
      voice.cancel();
      void navigation.then((composed) => composed?.dispose());
    },
    [navigation, voice],
  );
  const recovery = useMemo(
    () =>
      config.feasibilityMode
        ? null
        : createNavigationRecoveryController({
            isAppActive: () => visibilityRef.current === "active",
          }),
    [config.feasibilityMode],
  );

  /**
   * The nonce the document-start script currently publishes.
   *
   * It is rotated after a load finishes or fails, never while one is in flight: the
   * script that carries it runs as the document is created, so changing it
   * mid-navigation would hand the page a value the shell no longer accepts.
   */
  const [publishedNonce, setPublishedNonce] = useState(() => shell.registry.mintNonce());
  const documentInFlight = useRef(true);
  const missingDocumentTagReported = useRef(false);

  const handleLoadStart = useCallback(
    (event?: { nativeEvent?: { url?: string; openmapxDocumentStart?: boolean } }) => {
      // Android history callbacks can report loading=true even after a finish.
      // Only the patched native onPageStarted event identifies a new document.
      // A stale development APK must fail closed, never guess from progress.
      if (Platform.OS === "android" && event?.nativeEvent?.openmapxDocumentStart !== true) {
        if (
          __DEV__ &&
          event?.nativeEvent?.openmapxDocumentStart === undefined &&
          !missingDocumentTagReported.current
        ) {
          missingDocumentTagReported.current = true;
          console.error(
            "OpenMapX document-start tag missing; rebuild the Android development app.",
          );
        }
        return;
      }
      documentInFlight.current = true;
      // A real top-level navigation or reload.
      //
      // Navigation and its location driver survive a reload. Voice input is
      // owned by this document and must be cancelled before channel replacement.
      voice.cancel();
      incomingLinks.documentStarted();
      shell.registry.adoptDocument(publishedNonce, Date.now());
      shell.bridge.discardQueue();
      dispatchShell({ type: "document-load-started" });
    },
    [publishedNonce, shell, incomingLinks, voice],
  );

  const handleLoadEnd = useCallback(() => {
    // iOS emits load-end for pushState/replaceState too. Only the first end
    // after an actual start prepares the next document's bootstrap nonce.
    if (!documentInFlight.current) return;
    documentInFlight.current = false;
    // A load can finish while backgrounded; lifecycle delivery to the previous
    // document must not leave this document thinking the app is visible.
    webViewRef.current?.injectJavaScript(buildWebVisibilityScript(visibilityRef.current));
    dispatchShell({ type: "document-load-succeeded" });
    // Prepare a different nonce for whatever document loads next.
    setPublishedNonce(shell.registry.mintNonce());
  }, [shell]);

  const handleLoadFailure = useCallback(() => {
    documentInFlight.current = false;
    voice.cancel();
    dispatchShell({ type: "document-load-failed", offline: connectivity.displayed === "offline" });
    incomingLinks.documentStarted();
    shell.registry.invalidate();
    shell.bridge.discardQueue();
    // A retry must not reuse the failed document's nonce.
    setPublishedNonce(shell.registry.mintNonce());
  }, [shell, connectivity.displayed, incomingLinks, voice]);

  const legacyNoticed = useRef("");
  const announceIntake = useCallback(async () => {
    try {
      if (!(await intakePort.available())) return;
      const items = await intakePort.list();
      if ((shell.registry.handshake()?.protocolVersion ?? 0) >= 4) {
        shell.bridge.send("intake.changed", { pendingCount: items.length });
      } else if (items.length && visibilityRef.current === "active" && shell.registry.handshake()) {
        const key = items.map((item) => item.id).join(",");
        if (legacyNoticed.current === key) return;
        legacyNoticed.current = key;
        const failed = items.some((item) => item.kind === "error");
        const overflow = items.some(
          (item) => item.kind === "error" && item.errorCode === "inbox-full",
        );
        Alert.alert(
          failed
            ? locale === "de"
              ? "Inhalt konnte nicht hinzugefügt werden"
              : "Shared item could not be added"
            : locale === "de"
              ? "Geteilte Inhalte gespeichert"
              : "Shared items saved",
          overflow
            ? locale === "de"
              ? "Der Eingang ist voll. Die Webansicht aktualisieren und gespeicherte Inhalte öffnen oder verwerfen. Danach erneut teilen. Die Navigation läuft weiter."
              : "The inbox is full. Update the web view, open or discard saved items, then share again. Navigation continues."
            : failed
              ? locale === "de"
                ? "Einen Ort oder bis zu fünf GPX-, GeoJSON- oder KML-Dateien mit jeweils höchstens 5 MiB teilen. Die Webansicht für die Inhaltsprüfung aktualisieren. Die Navigation läuft weiter."
                : "Share a location or up to five GPX, GeoJSON or KML files of at most 5 MiB each. Update the web view to review saved items. Navigation continues."
              : locale === "de"
                ? "Die Webansicht benötigt ein Update. Gespeicherte Inhalte bleiben bis zu 24 Stunden auf diesem Gerät. Die Navigation läuft weiter."
                : "The web view needs an update. Saved items stay on this device for up to 24 hours. Navigation continues.",
        );
      }
    } catch {
      /* Optional module absence cannot interrupt navigation. */
    }
  }, [intakePort, shell, locale]);
  useEffect(
    () =>
      intakePort.listen(() => {
        void announceIntake();
      }),
    [intakePort, announceIntake],
  );
  useEffect(() => {
    if (visibility === "active") void announceIntake();
  }, [visibility, announceIntake]);
  const handleMessage = useCallback(
    (event: { nativeEvent: { url?: string; data?: string } }) => {
      // Rejections are silent by design: an error reply to an unauthenticated
      // sender is itself an oracle, and every rejection path is side-effect free.
      void shell.bridge
        .receive(event.nativeEvent)
        .then((outcome) => {
          if (
            outcome.status === "handled" &&
            outcome.type === "web.hello" &&
            shell.registry.handshake()
          ) {
            incomingLinks.bridgeReady();
            void announceIntake();
          }
        })
        .catch(() => undefined);
    },
    [shell, incomingLinks, announceIntake],
  );

  const openExternally = useCallback((url: string) => {
    // `openURL` rejects for schemes no installed app handles. Swallowing that is
    // correct: the user tapped a link we deliberately refuse to render, and a
    // native crash would be a far worse outcome than nothing happening.
    void Linking.openURL(url).catch(() => undefined);
  }, []);

  const handleNavigationRequest = useCallback(
    (request: { url: string }): boolean => {
      const decision = classifyNavigation(request.url, config);
      if (decision === "allow-in-webview") return true;
      if (decision === "open-system") openExternally(request.url);
      return false;
    },
    [config, openExternally],
  );

  // Connectivity is an input to the shell's explanation, never authority over a
  // session: losing the network does not end navigation or discard a route.
  useEffect(() => {
    dispatchShell({ type: "connectivity-changed", online: connectivity.displayed !== "offline" });
  }, [connectivity.displayed]);

  // Durable session state and the operating-system driver are the authority.
  // Reconcile on process creation and every visibility transition; never infer
  // navigation from what the WebView happened to render.
  useEffect(() => {
    if (!recovery) return undefined;
    let disposed = false;
    void recovery
      .then((controller) => controller.reconcile(visibility))
      .then((event) => {
        if (!disposed) dispatchShell({ type: event });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [recovery, visibility]);

  /**
   * Keep-awake, narrowly.
   *
   * The navigation composition holds the screen only while the app is
   * foregrounded, a session is being tracked and its keep-screen-on setting is
   * on. It re-checks after its own commits; visibility changes and recovery
   * outcomes (which change `navigating`) happen here, so they ask it to look
   * again. It is never part of the background task: holding a wake lock from a
   * headless callback would drain the battery for a screen nobody is looking at.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibility and navigating are the triggers for a fresh keep-awake review, not values the effect reads.
  useEffect(() => {
    void navigation.then((composed) => composed?.reviewKeepAwake()).catch(() => undefined);
  }, [navigation, visibility, shellState.context.navigating]);

  const handleShellAction = useCallback(
    (action: ShellAction) => {
      switch (action) {
        case "retry":
          setLoadAttempt((attempt) => attempt + 1);
          dispatchShell({ type: "document-load-started" });
          return;
        case "open-network-settings":
        case "open-app-settings":
          void Linking.openSettings().catch(() => undefined);
          return;
        case "resume":
          if (!recovery) return;
          void recovery
            .then((controller) => controller.resume())
            .then((event) => dispatchShell({ type: event }))
            .catch(() => undefined);
          return;
        case "end":
          if (!recovery) return;
          void recovery
            .then((controller) => controller.end())
            .then((event) => dispatchShell({ type: event }))
            .catch(() => undefined);
          return;
        case "dismiss":
          dispatchShell({ type: "dismissed" });
      }
    },
    [recovery],
  );

  return (
    <View
      style={[styles.root, { backgroundColor: palette.background }]}
      // Observes (never claims) touches on the WebView for the voice gate.
      onTouchStart={voiceIntent.touched}
      testID="product-shell"
    >
      <ShellStatusBar palette={palette} />
      <WebView
        key={loadAttempt}
        ref={webViewRef}
        source={webSource}
        style={styles.webView}
        // Exact origin, both as a navigation allowlist and as the WebKit
        // App-Bound Domain set generated into Info.plist.
        originWhitelist={[config.webOrigin]}
        limitsNavigationsToAppBoundDomains
        mixedContentMode="never"
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsInlineMediaPlayback={false}
        // Native voice input owns the microphone; WebView capture remains denied.
        mediaCapturePermissionGrantType="deny"
        // Geolocation is native's, exclusively. A page that could ask the
        // WebView for it would be a second location producer racing the one
        // that actually keeps working with the screen off.
        geolocationEnabled={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled={false}
        allowsBackForwardNavigationGestures
        onShouldStartLoadWithRequest={handleNavigationRequest}
        // Android's Back button goes back in the page before it leaves the app.
        onNavigationStateChange={handleNavigationStateChange}
        onOpenWindow={(event) => {
          // Popups get the same structural policy as ordinary navigation; they
          // never open a second in-app browser.
          handleNavigationRequest({ url: event.nativeEvent.targetUrl });
        }}
        // The nonce goes in before any page script runs, and only into the main
        // frame — an iframe never receives it, so it cannot address the channel.
        injectedJavaScriptBeforeContentLoaded={buildChannelBootstrapScript(publishedNonce)}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        injectedJavaScriptForMainFrameOnly
        // Only the map zooms; the interface never scales under a pinch or double
        // tap. WKWebView has no such switch, so the page narrows its own viewport
        // when it finds the shell descriptor.
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        onMessage={handleMessage}
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
        onError={handleLoadFailure}
        onHttpError={handleLoadFailure}
        // Remote inspection only in development builds; a release WebView stays
        // closed to debuggers.
        webviewDebuggingEnabled={__DEV__}
        testID="product-webview"
      />
      {shellState.state.kind === "loading" ? <LoadingOverlay locale={locale} /> : null}
      <NativeRecoveryOverlay
        locale={locale}
        state={shellState.state}
        onAction={handleShellAction}
      />
      <PermissionPrompts prompter={prompter} locale={locale} />
      {config.feasibilityMode ? <FeasibilityOverlay /> : null}
    </View>
  );
}

export function App(): ReactElement {
  // A malformed compiled configuration is fatal by design: continuing would
  // mean guessing which server to trust.
  const configuration = useMemo(() => {
    try {
      return { ok: true as const, config: getRuntimeConfig() };
    } catch {
      return { ok: false as const };
    }
  }, []);
  const locale = useMemo(() => deviceMobileLocale(), []);
  const palette = useNativePalette();

  if (!configuration.ok) {
    return (
      <View style={[styles.root, { backgroundColor: palette.background }]}>
        <ShellStatusBar palette={palette} />
        <NativeRecoveryOverlay
          locale={locale}
          state={{ kind: "fatal-config" }}
          onAction={() => undefined}
        />
      </View>
    );
  }
  return <ProductShell config={configuration.config} />;
}
