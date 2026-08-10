import type { DeepLinkConfig, DeepLinkIntent } from "./deepLinkIntent";
import { coldStartUrl, parseDeepLinkIntent } from "./deepLinkIntent";

/**
 * Deciding what a link does, depending on whether the app was already running.
 *
 * A cold start has no page to talk to, so the link becomes the WebView's initial
 * URL — built from the compiled origin, never from the link's own string. A warm
 * app already has a page, and reloading it would throw away whatever the user
 * was doing, so the link becomes a bounded bridge message instead.
 *
 * The same link delivered twice does one thing. The OS legitimately re-delivers:
 * a notification tapped while the app is resuming can arrive as both a launch
 * URL and a URL event, and acting on both would navigate the user twice.
 */

export interface DeepLinkSink {
  /** Points a not-yet-created WebView at this URL. */
  setInitialUrl(url: string): void;
  /** Sends a bounded intent to a page that is already running. */
  deliver(intent: DeepLinkIntent): void;
}

export type DeepLinkOutcome = "cold-start" | "delivered" | "duplicate" | "refused";

export class DeepLinkController {
  private warm = false;
  private lastLink: string | null = null;

  constructor(
    private readonly config: DeepLinkConfig,
    private readonly sink: DeepLinkSink,
  ) {}

  /** Called once the WebView has a page that can receive intents. */
  markWarm(): void {
    this.warm = true;
  }

  /**
   * Called when the page goes away — a reload, or a load failure.
   *
   * Also forgets the last link: after a reload the same link is a genuinely new
   * request, because whatever it did the first time is gone.
   */
  markCold(): void {
    this.warm = false;
    this.lastLink = null;
  }

  handle(rawLink: string): DeepLinkOutcome {
    const intent = parseDeepLinkIntent(rawLink, this.config);
    if (!intent) return "refused";

    // Compared before the warm check: a duplicate is a duplicate whether it
    // arrives as a second launch URL or as a URL event during resume.
    if (rawLink === this.lastLink) return "duplicate";
    this.lastLink = rawLink;

    if (!this.warm) {
      this.sink.setInitialUrl(coldStartUrl(intent, this.config));
      return "cold-start";
    }
    this.sink.deliver(intent);
    return "delivered";
  }
}
