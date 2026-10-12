/**
 * Message delivery receipts.
 *
 * The API has always returned `deliveredAt` and `seenAt`, but nothing declared
 * or rendered them, so a sender saw a bare clock time and had no way to tell
 * whether a message had arrived or been read. On mobile data, where a reply that
 * never lands is indistinguishable from a landlord going quiet, that is the
 * single most consequential missing signal in the chat.
 *
 * Kept out of the page module because Next.js only permits a page and its config
 * to be exported from an app route file.
 */

/** The three things worth knowing about a message you sent. */
export type DeliveryState = 'sending' | 'sent' | 'delivered' | 'seen';

export interface ReceiptableMessage {
  createdAt: string;
  moderationStatus?: string;
  deliveredAt?: string | null;
  seenAt?: string | null;
}

/**
 * Resolves a single ordered state.
 *
 * `seen` takes precedence over `delivered` because a seen message was
 * necessarily delivered, so collapsing them into one value stops the bubble from
 * ever showing two ticks at once.
 *
 * `sending` is a real state rather than a spinner: a message still in the
 * moderation queue is not yet on the recipient's screen, and calling that "sent"
 * would be a lie the recipient can disprove.
 */
export function deliveryState(message: ReceiptableMessage): DeliveryState {
  if (message.moderationStatus === 'PENDING') return 'sending';
  if (message.seenAt) return 'seen';
  if (message.deliveredAt) return 'delivered';
  return 'sent';
}

/** Short label rendered on the bubble. */
export const RECEIPT_LABEL: Record<DeliveryState, string> = {
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  seen: 'Seen',
};

/**
 * Tooltip carrying the actual timestamp.
 *
 * The bare label cannot answer "seen when?", which is the question a poster
 * actually has after an agent goes quiet. The visible label stays short enough to
 * sit inside a narrow bubble on a phone; the precise time is one hover or
 * long-press away.
 */
export function receiptTitle(message: ReceiptableMessage): string {
  const at = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';

  switch (deliveryState(message)) {
    case 'seen':
      return `Seen at ${at(message.seenAt)}`;
    case 'delivered':
      return `Delivered at ${at(message.deliveredAt)}`;
    case 'sending':
      return 'Waiting to pass our checks before delivery';
    default:
      return `Sent at ${at(message.createdAt)}`;
  }
}
