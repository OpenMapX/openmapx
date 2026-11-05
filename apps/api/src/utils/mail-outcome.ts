/** Conclusive provider rejection before message acceptance. Everything else is ambiguous. */
export class MailDeliveryRefusedError extends Error {
  constructor() {
    super("The mail provider refused the message");
    this.name = "MailDeliveryRefusedError";
  }
}
