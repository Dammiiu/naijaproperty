'use client';

/**
 * Message composer and reply poller.
 *
 * Owns everything after the server-rendered thread: sending, optimistic display,
 * and picking up replies.
 *
 * Idempotency is the important part. `clientMessageId` is generated once per
 * composed message and reused across every retry, so a request that times out on a
 * slow connection can be retried without the recipient seeing the same enquiry
 * twice. The API upserts on that key, so a replay returns the original message.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadMessage } from '@/app/messages/[id]/page';

const MAX_LENGTH = 4000;
const POLL_MS = 10_000;

export function MessageThread({
  conversationId,
  initialMessages,
  counterpartName,
  disabled,
  disabledReason,
}: {
  conversationId: string;
  initialMessages: ThreadMessage[];
  counterpartName: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs rather than state: the poll interval must not be torn down and rebuilt on
  // every message, and the composer must not re-render the whole thread as you
  // type.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Pending sends, so a page closed mid-flight is retried on return rather than
  // silently losing the message.
  const outbox = useRef<Array<{ clientMessageId: string; body: string }>>([]);

  const send = useCallback(
    async (clientMessageId: string, body: string) => {
      const res = await fetch(`/api/messages/${conversationId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, clientMessageId }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? 'Message could not be sent');
      }
    },
    [conversationId],
  );

  const flushOutbox = useCallback(async () => {
    if (outbox.current.length === 0) return;

    for (const item of [...outbox.current]) {
      try {
        await send(item.clientMessageId, item.body);
        outbox.current = outbox.current.filter((o) => o.clientMessageId !== item.clientMessageId);
        setError(null);
      } catch (err) {
        // Kept in the outbox so the next attempt retries it. The optimistic bubble
        // stays on screen the whole time, so the user sees their message and is
        // told it has not sent yet rather than watching it vanish.
        setError(
          `${counterpartName} has not got that yet. We will keep trying, or you can resend.`,
        );
        void err;
        return;
      }
    }
  }, [send, counterpartName]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    // cuid-shaped so the API's own validation is satisfied without a client-side
    // duplicate of the rule.
    const clientMessageId = `cm${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 12)}`;

    setSending(true);
    setError(null);
    setDraft('');

    // Optimistic. Marked as not yet confirmed rather than pretending to be sent,
    // because on a bad connection it may not be.
    const optimistic: ThreadMessage = {
      id: clientMessageId,
      clientMessageId,
      senderId: 'me',
      isMine: true,
      body,
      createdAt: new Date().toISOString(),
      editedAt: null,
      moderationStatus: 'PENDING',
      attachment: null,
    };
    setMessages((prev) => [...prev, optimistic]);
    outbox.current.push({ clientMessageId, body });

    try {
      await send(clientMessageId, body);
      outbox.current = outbox.current.filter((o) => o.clientMessageId !== clientMessageId);
      // The server owns createdAt and the moderation status, so the optimistic
      // copy is replaced rather than assumed correct.
      await refresh();
    } catch {
      setError('That message has not sent. It will retry automatically.');
    } finally {
      setSending(false);
    }
  }

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages/${conversationId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const payload = (await res.json()) as { messages: ThreadMessage[] };
      setMessages(payload.messages);
      await fetch(`/api/messages/${conversationId}/read`, { method: 'POST' }).catch(() => undefined);
    } catch {
      // A failed poll is not worth interrupting the user over. The next one tries
      // again, and sending still works.
    }
  }, [conversationId]);

  useEffect(() => {
    flushOutbox();
  }, [flushOutbox]);

  useEffect(() => {
    // Only poll while the tab is visible. A background tab polling every ten
    // seconds is battery and data the user is not getting anything from.
    let timer: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (timer) return;
      timer = setInterval(refresh, POLL_MS);
    }
    function stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') {
        refresh();
        flushOutbox();
        start();
      } else {
        stop();
      }
    }

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh, flushOutbox]);

  if (disabled) {
    return (
      <div className="composer is-closed">
        <p className="composer__closed">{disabledReason ?? 'This conversation is closed.'}</p>
      </div>
    );
  }

  const remaining = MAX_LENGTH - draft.length;

  return (
    <form className="composer" onSubmit={submit}>
      <label className="visually-hidden" htmlFor="composer">
        Message
      </label>
      <textarea
        id="composer"
        className="composer__box"
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, MAX_LENGTH))}
        placeholder={`Message ${counterpartName}…`}
        rows={3}
        disabled={sending}
      />

      <div className="composer__row">
        <p className="composer__count" aria-live="polite">
          {remaining < 200 ? `${remaining} characters left` : ''}
        </p>
        <button type="submit" className="btn btn--primary" disabled={sending || !draft.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {error ? (
        <p className="composer__error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="composer__hint">
        Never send money before you have seen the property. We never ask for a payment to unlock
        contact details.
      </p>
    </form>
  );
}