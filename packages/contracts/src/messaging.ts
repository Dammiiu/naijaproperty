/**
 * Messaging contracts: per-listing conversations over WebSocket with an HTTP
 * fallback for history and offline outbox replay.
 */

import { z } from 'zod';
import { cuid } from './primitives.js';
import { listingKindSchema } from './listing.js';

export const conversationSummarySchema = z.object({
  id: cuid,
  listingId: cuid,
  listingTitle: z.string(),
  listingKind: listingKindSchema,
  coverImageUrl: z.string().nullable(),
  /** The other participant, resolved for the requesting user. */
  counterpart: z.object({
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    verificationTier: z.string(),
    isOwner: z.boolean(),
  }),
  lastMessagePreview: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  unreadCount: z.number().int().nonnegative(),
  status: z.enum(['ACTIVE', 'BLOCKED', 'ARCHIVED']),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const messageSchema = z.object({
  id: cuid,
  conversationId: cuid,
  senderId: cuid,
  body: z.string().max(4000),
  attachmentMediaId: cuid.nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  moderationStatus: z.enum(['PENDING', 'CLEAR', 'FLAGGED', 'REJECTED']),
});
export type Message = z.infer<typeof messageSchema>;

/** Client-generated id so an offline outbox can be replayed idempotently. */
export const sendMessageSchema = z.object({
  conversationId: cuid,
  clientMessageId: z.string().min(8).max(64),
  body: z.string().trim().min(1, 'Write a message').max(4000),
  attachmentMediaId: cuid.optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const listMessagesQuerySchema = z.object({
  conversationId: cuid,
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

// --- WebSocket frames ------------------------------------------------------

export const wsClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('subscribe'), conversationId: cuid }),
  z.object({ t: z.literal('typing'), conversationId: cuid, isTyping: z.boolean() }),
  z.object({ t: z.literal('send'), ...sendMessageSchema.shape }),
  z.object({ t: z.literal('read'), conversationId: cuid, messageId: cuid }),
  z.object({ t: z.literal('ping') }),
]);
export type WsClientFrame = z.infer<typeof wsClientFrameSchema>;

export const wsServerFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('message'), message: messageSchema }),
  z.object({ t: z.literal('ack'), clientMessageId: z.string(), messageId: cuid }),
  z.object({ t: z.literal('typing'), conversationId: cuid, userId: cuid, isTyping: z.boolean() }),
  z.object({ t: z.literal('read'), conversationId: cuid, userId: cuid, messageId: cuid }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string(), clientMessageId: z.string().optional() }),
  z.object({ t: z.literal('pong') }),
  z.object({
    t: z.literal('review'),
    listingId: cuid,
    status: z.enum(['PENDING_REVIEW', 'LIVE', 'REJECTED', 'CHANGES_REQUESTED']),
    slaDueAt: z.string().nullable(),
  }),
]);
export type WsServerFrame = z.infer<typeof wsServerFrameSchema>;
