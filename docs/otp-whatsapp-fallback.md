# Phone OTP: WhatsApp-first with cost-aware SMS fallback

## Why this design

Termii charges separately per channel. SMS is the expensive one; WhatsApp is cheaper and is read far
more reliably in Nigeria. So the strategy is: **always try WhatsApp first, and spend an SMS only when
WhatsApp genuinely did not deliver.**

This is not a simple "try WhatsApp, then try SMS" retry. Sending an SMS immediately after a WhatsApp
send would double the cost of every single verification, because Termii returns HTTP 200 as soon as a
message is *accepted by the network* — that says nothing about whether the handset received it. The
only signal that actually tells us WhatsApp worked is the asynchronous delivery webhook.

## The flow

```
1. POST /auth/otp/request  { phone, clientHint }
2. Generate a 6-digit code. Persist only HMAC-SHA256(code, OTP_PEPPER).
3. POST {TERMII_BASE_URL}/api/sms/send  channel=whatsapp_otp   -> message_id
4. Set smsFallbackDueAt = now + OTP_SMS_FALLBACK_DELAY_SECONDS (default 20s)
5. Status = SENT. Return to client immediately; user is not blocked.

   Meanwhile:
   - Termii POSTs the delivery report to /auth/termii/webhook
   - signature verified as HMAC-SHA512(raw body, TERMII_WEBHOOK_SECRET)
   - status "Delivered"  -> clear smsFallbackDueAt, mark whatsappDeliveredAt
   - status "Failed"/"Expired"/"Rejected"/"DND Active" -> set smsFallbackDueAt = now

6. Cron sweep runs every 5 seconds:
   challenges where status IN (SENT, PENDING)
     AND smsFallbackDueAt <= now
     AND smsFallbackSentAt IS NULL
     AND expiresAt > now
     AND smsMessageId IS NULL
     AND primaryChannel = WHATSAPP
   -> send the same code over SMS, record smsMessageId

7. POST /auth/otp/verify  { phone, code }
   Constant-time compare against the stored HMAC.
   On success: mark VERIFIED, mark phone verified, upgrade tier, issue session.
```

## Why the code is never persisted in plaintext

We only store `HMAC-SHA256(code, OTP_PEPPER)`, so a database leak does not yield live OTP codes.

The consequence is that the SMS fallback cannot be composed *after the fact* from the database row,
because the plaintext no longer exists there. Instead the plaintext is held in a short-lived in-process
map, keyed by challenge id, and dropped as soon as the challenge is delivered, verified, or expires:

```ts
this.setPlaintext(challenge.id, code);   // setTimeout ttl, .unref()
```

This is honest about its limits. **It is per-instance.** Phase 0 runs a single API process, so this is
correct today. The moment the API is scaled horizontally, that map must move to Redis with a TTL
matching `OTP_TTL_SECONDS`, otherwise only the instance that issued a challenge can perform its fallback.

If the plaintext has already been evicted when the sweep runs, the challenge is expired rather than
retried, and the client is asked for a new code. That is the safe failure mode: a wasted tap is better
than a wrong code.

The phone number has the same problem, since `otp_challenges` stores only the blind index. It is
resolved at sweep time from the user's encrypted `phone_enc` where a `userId` exists, and from a
short-lived cache for anonymous pre-registration flows.

## Configurable window

`OTP_SMS_FALLBACK_DELAY_SECONDS` accepts 5–120 and defaults to 20. The trade-off:

| Delay | Effect |
| --- | --- |
| 10–15s | Cheaper, but more users wait on a code that is already in their WhatsApp |
| 20–30s | Sensible default. Most WhatsApp deliveries report inside a few seconds |
| 60s+ | Fewest wasted SMS, noticeably worse time-to-code |

## Idempotency

Termii can retry a webhook. Each delivery report is inserted into `webhook_events` with a unique key of
`(provider, externalId)` where `externalId` is `"{message_id}:{status}"`. A duplicate insert is caught
and answered with `{ duplicate: true }` rather than being applied twice, so a replayed `Delivered` can
never resurrect an already-swept fallback.

## Signature verification

`X-Termii-Signature` is an HMAC-SHA512 of the **raw request body**. Verifying the parsed-and-re-serialised
JSON would break the signature, so `main.ts` installs a `Content-Type` parser that stashes `rawBody` on
the request before JSON parsing. The webhook handler reads that buffer directly.

A request with an absent, malformed, or non-matching signature is rejected with 401 before any
database work happens.

## Termii account setup

Verified live against the `Naija property` account (₦30 welcome balance). Findings:

1. **`TERMII_BASE_URL` is account specific.** Your dashboard shows `https://v4.api.termii.com`.
   The older `https://api.termii.com` also answers and returns identical results, but v4 is what the
   dashboard reports, so that is what we configure.

2. **The WhatsApp OTP endpoint is not enabled on every account by default.** `channel=whatsapp_otp`
   must be activated with Termii support, and `TERMII_WHATSAPP_FROM` must be the *device name* of a
   connected WhatsApp device. Until both are set, `GET /auth/otp/channels` reports `whatsapp: false`
   and the client sends SMS directly instead of arming a timer that would never fire. This is the
   correct degraded behaviour, not a bug.

3. **The SMS sender ID must be registered.** An unregistered sender is rejected:

   ```
   HTTP 422
   SENDER_ID_NOT_APPROVED: sender ID 'Naijaproperty' is not registered for
   workspace 01a113f8-f57e-7bf5-83a8-cb4eed6ef05b
   ```

   `TERMII_SMS_FROM` must be a sender ID already approved in the Termii dashboard, 3 to 11
   alphanumeric characters. Until one is registered, every SMS send fails. Termii's error message is
   surfaced verbatim through the OTP challenge's `moderation_notes`-equivalent path and in the
   structured log, so this is diagnosable without reading provider documentation.

### Confirming credentials without spending credit

A send to a non-existent recipient proves authentication, base URL, and payload shape at zero cost,
because the request fails at business logic rather than at the billing step:

```powershell
$key = "<your key>"
$body = @{ api_key = $key; to = "2340000000000"; from = "<registered sender>"
           sms = "123456"; type = "plain"; channel = "generic" } | ConvertTo-Json
Invoke-WebRequest -Uri "https://v4.api.termii.com/api/sms/send" -Method Post `
  -Body $body -ContentType "application/json"
```

A `422 SENDER_ID_NOT_APPROVED` means credentials are valid and only the sender is unregistered. A
`401`/`403` means the key is wrong.

Balance can be checked without sending anything:

```
GET https://v4.api.termii.com/api/get-balance?api_key=<key>
-> { "balance": 30.0000, "currency": "NGN", "application": "Naija property" }
```

## Testing the fallback

1. Set `OTP_SMS_FALLBACK_DELAY_SECONDS=15`.
2. Request an OTP.
3. Either point `TERMII_WEBHOOK_SECRET` at a wrong value so the delivery webhook is rejected, or
   request with `clientHint: "SMS"` to bypass WhatsApp.
4. Within ~20s, `smsMessageId` should be populated on the challenge and a second SMS should have been
   dispatched.

The sweep logs `SMS fallback sweep: <sent>/<swept> sent`, so this is observable without a client.
