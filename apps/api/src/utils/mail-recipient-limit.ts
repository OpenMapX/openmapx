import { createHmac } from "node:crypto";
import { envString } from "@openmapx/core/server-env";
import type Redis from "ioredis";

/**
 * How many messages one mailbox receives from this instance per hour.
 *
 * Sign-up, verification, password reset and email change mail can be
 * triggered for an address the requester does not own. Per-IP limits bound one
 * client; this bounds what any number of clients can send to one person.
 * Legitimate use stays far below it.
 */
export const MAIL_RECIPIENT_HOURLY_LIMIT = 10;
const WINDOW_MS = 3_600_000;
/** A shared-store answer slower than this is treated as no answer. */
const STORE_TIMEOUT_MS = 1_000;

/** Counts one message and starts the window on the first one, atomically. */
const COUNT_SCRIPT = `
-- openmapx-mail-recipient-count
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Folds the spellings that reach the same mailbox into one: case, a `+tag`
 * suffix, and Gmail's ignored dots and alternate domain.
 */
export function normalizeMailRecipient(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1).replace(/\.+$/, "");
  const tag = local.indexOf("+");
  if (tag > 0) local = local.slice(0, tag);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/**
 * The shared-store key for an address. The store never holds the address, and
 * keying the digest with the server secret keeps it from being reversed by
 * hashing a list of likely addresses.
 */
export function mailRecipientKey(
  address: string,
  secret: string = envString("BETTER_AUTH_SECRET", ""),
): string {
  const digest = createHmac("sha256", secret)
    .update("openmapx-mail-recipient\0")
    .update(normalizeMailRecipient(address))
    .digest("hex");
  return `mail-recipient:${digest}`;
}

export interface MailRecipientLimitOptions {
  /** The shared store, or null where the deployment runs without one. */
  store: Pick<Redis, "eval"> | null;
  limit?: number;
  windowMs?: number;
  timeoutMs?: number;
  /** Called when the store cannot answer and the message goes out uncounted. */
  onUnavailable?: () => void;
}

/**
 * When the shared store cannot answer, mail goes out uncounted. Verification
 * and password reset are how people get into their accounts. Because a refused message looks exactly like a sent one, a
 * store outage that silently stopped them would be invisible. The per-IP
 * limits still apply while the store is down.
 */
export function createMailRecipientLimit(options: MailRecipientLimitOptions) {
  const limit = options.limit ?? MAIL_RECIPIENT_HOURLY_LIMIT;
  const windowMs = options.windowMs ?? WINDOW_MS;
  const timeoutMs = options.timeoutMs ?? STORE_TIMEOUT_MS;
  return {
    /** Counts one message to `address` and says whether it may be sent. */
    async admit(address: string): Promise<boolean> {
      const store = options.store;
      if (!store) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const count = await Promise.race([
          store.eval(COUNT_SCRIPT, 1, mailRecipientKey(address), String(windowMs)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Mail recipient count timed out")),
              timeoutMs,
            );
            timer.unref?.();
          }),
        ]);
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)
          throw new Error("Unexpected mail recipient count");
        return count <= limit;
      } catch {
        options.onUnavailable?.();
        return true;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
