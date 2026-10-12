/**
 * In-app messaging.
 *
 * Exists because the reveal flow already opens a conversation. Someone who has
 * unlocked a phone number can call, but the thread has to live here too: the
 * owner needs a place to answer, and keeping the exchange on-platform is what
 * makes a scammer's behaviour reportable.
 *
 * Two design decisions worth stating:
 *
 * 1. Messages start at PENDING moderation and are visible to the sender only.
 *    A marketplace that lets anyone message anyone needs to stop fraud before it
 *    reaches the owner, otherwise the first thing a poster sees is a stream of
 *    advance-fee requests. A CLEARed message becomes visible to both sides.
 *
 * 2. Every read is owner-scoped by participant, never by "knows the id". A
 *    conversation id is a cuid and appears in reveal responses, so it is not a
 *    secret; authorisation has to come from the row, not the guess.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ConversationStatus, ModerationStatus } from '@prisma/client';
import { ApiException } from '@naijaproperty/contracts';
import { PrismaService } from '../../common/prisma.service.js';
import { publicImageUrl } from '../../common/media-url.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';

@ApiTags('messages')
@Controller()
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The viewer's conversations, newest activity first.
   *
   * Both sides of every conversation the user participates in, because the same
   * page serves a renter chasing an owner and an owner fielding enquiries.
   */
  @Get('conversations')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Conversations the viewer takes part in' })
  async list(@Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const rows = await this.prisma.conversation.findMany({
      where: {
        OR: [{ initiatorId: userId }, { ownerId: userId }],
      },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: {
        listing: {
          select: {
            id: true,
            title: true,
            kindCode: true,
            price: true,
            pricePeriod: true,
            status: true,
            area: { select: { name: true } },
            lga: { select: { name: true } },
            media: {
              orderBy: { position: 'asc' },
              take: 1,
              select: {
                mediaAsset: { select: { id: true, storageKey: true } },
              },
            },
          },
        },
        // Only the counterpart, resolved here rather than returned as a user id
        // the client would then have to look up.
        initiator: { select: { id: true, displayName: true } },
        owner: { select: { id: true, displayName: true } },
        _count: { select: { messages: { where: { deletedAt: null } } } },
      },
    });

    const now = Date.now();

    // Unread is resolved by a separate batched pass, which needs the ids first.
    const unreadCounts = await this.unreadByConversation(
      userId,
      rows.map((c) => c.id),
    );

    return {
      items: rows.map((c) => {
        const counterpart = c.initiatorId === userId ? c.owner : c.initiator;
        const cover = c.listing.media[0]?.mediaAsset;
        const unread = unreadCounts.get(c.id) ?? 0;

        return {
          id: c.id,
          listingId: c.listing.id,
          listingTitle: c.listing.title,
          listingKind: c.listing.kindCode,
          listingPrice: Number(c.listing.price),
          listingPricePeriod: c.listing.pricePeriod,
          // A conversation whose listing was withdrawn stays readable, but the
          // client needs to know the property is no longer available or the
          // owner looks unresponsive for no visible reason.
          listingIsLive: c.listing.status === 'LIVE',
          listingLocation: [c.listing.area?.name, c.listing.lga.name].filter(Boolean).join(', '),
          listingCoverUrl: cover ? publicImageUrl(cover.id, undefined, cover.storageKey) : null,
          counterpartId: counterpart.id,
          counterpartName: counterpart.displayName,
          status: c.status,
          lastMessageAt: c.lastMessageAt?.toISOString() ?? c.createdAt.toISOString(),
          lastMessagePreview: c.lastMessagePreview,
          messageCount: c._count.messages,
          unread,
          isInitiator: c.initiatorId === userId,
          // Drives the "active now" affordance, which matters more on a
          // marketplace than read receipts do.
          updatedWithinAnHour: (now - (c.lastMessageAt ?? c.createdAt).getTime()) < 3_600_000,
        };
      }),
    };
  }

  /**
   * One conversation's messages.
   *
   * Pending messages are returned to their sender and hidden from the
   * recipient. Returning them to both would mean the owner sees a fraud attempt
   * the moment it is sent, which is exactly what this is designed to prevent.
   */
  @Get('conversations/:id')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Messages in one conversation' })
  async thread(@Param('id') id: string, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        listing: {
          select: { id: true, title: true, status: true, kindCode: true, price: true, pricePeriod: true },
        },
        initiator: { select: { id: true, displayName: true } },
        owner: { select: { id: true, displayName: true } },
      },
    });

    // A conversation id that is not yours is reported as missing, not forbidden.
    // Distinguishing the two confirms the id exists.
    if (!conversation || !this.isParticipant(conversation, userId)) {
      throw ApiException.notFound('Conversation not found');
    }

    const messages = await this.prisma.message.findMany({
      where: { conversationId: id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 500,
      include: {
        sender: { select: { id: true, displayName: true } },
        attachment: { select: { id: true, kind: true, storageKey: true, mime: true } },
      },
    });

    /*
     * Receipts.
     *
     * `seen` is read from the conversation's read marker rather than stored per
     * message: the marker already records the furthest point the other side has
     * read, so a duplicate column could only ever disagree with it.
     *
     * `delivered` is written here, by the recipient's own fetch, and only for
     * messages from the other party that are still null. The WHERE clause makes
     * it idempotent and lets the partial index skip everything already stamped,
     * so a polling client does not turn into a write per message per poll.
     */
    const readMarker = await this.prisma.messageRead.findUnique({
      where: {
        conversationId_userId: {
          conversationId: id,
          userId: this.counterpartId(conversation, userId),
        },
      },
      select: { lastReadAt: true },
    });
    const seenAt = readMarker?.lastReadAt ?? null;

    if (conversation.initiatorId !== userId) {
      void this.prisma.message
        .updateMany({
          where: {
            conversationId: id,
            senderId: conversation.initiatorId,
            deliveredAt: null,
            // Never stamp a message the recipient is not allowed to see, or a
            // pending one the moderation gate is still holding.
            moderationStatus: 'CLEAR',
            deletedAt: null,
          },
          data: { deliveredAt: new Date() },
        })
        .catch(() => undefined);
    }

    const counterpart = conversation.initiatorId === userId ? conversation.owner : conversation.initiator;

    return {
      id: conversation.id,
      status: conversation.status,
      listing: {
        id: conversation.listing.id,
        title: conversation.listing.title,
        isLive: conversation.listing.status === 'LIVE',
        kind: conversation.listing.kindCode,
        price: Number(conversation.listing.price),
        pricePeriod: conversation.listing.pricePeriod,
      },
      counterpart: { id: counterpart.id, displayName: counterpart.displayName },
      isInitiator: conversation.initiatorId === userId,
      messages: messages
        .filter((m) => this.isVisibleTo(m, userId))
        .map((m) => ({
          id: m.id,
          clientMessageId: m.clientMessageId,
          senderId: m.senderId,
          isMine: m.senderId === userId,
          body: m.body,
          createdAt: m.createdAt.toISOString(),
          editedAt: m.editedAt?.toISOString() ?? null,
          /*
           * Receipts, and only on the sender's own messages.
           *
           * A read receipt on the recipient's message is meaningless (you always
           * know when you wrote something), and returning them would invite the
           * client to render "seen" next to the wrong bubble.
           *
           * `seen` uses `<=` on the timestamps rather than comparing message
           * ids: the read marker records a time, and a message created at exactly
           * that instant was on screen.
           */
          deliveredAt:
            m.senderId === userId ? (m.deliveredAt?.toISOString() ?? null) : null,
          seenAt:
            m.senderId === userId && seenAt && m.createdAt <= seenAt
              ? seenAt.toISOString()
              : null,
          // Only the sender is told their message is awaiting review. Telling
          // the recipient would defeat the point.
          moderationStatus: m.senderId === userId ? m.moderationStatus : undefined,
          moderationNote: m.senderId === userId ? m.moderationNotes : undefined,
          attachment: m.attachment
            ? {
                id: m.attachment.id,
                kind: m.attachment.kind,
                mime: m.attachment.mime,
                url:
                  m.attachment.kind === 'IMAGE'
                    ? publicImageUrl(m.attachment.id, undefined, m.attachment.storageKey)
                    : null,
              }
            : null,
        })),
    };
  }

  /** The other participant's user id, whichever side this user is on. */
  private counterpartId(
    conversation: { initiatorId: string; ownerId: string },
    userId: string,
  ): string {
    return conversation.initiatorId === userId ? conversation.ownerId : conversation.initiatorId;
  }

  /**
   * Send a message.
   *
   * Idempotent on `clientMessageId`. Without it, a retry after a dropped
   * response on a poor connection duplicates the message, and the owner sees the
   * same enquiry twice and reads the poster as unreliable.
   */
  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a message in a conversation' })
  async send(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
  ) {
    const userId = this.userId(req);

    const parsed = z
      .object({
        body: z.string().trim().min(1).max(4000),
        clientMessageId: z.string().cuid(),
      })
      .safeParse(body);

    if (!parsed.success) {
      throw ApiException.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      select: { id: true, initiatorId: true, ownerId: true, status: true },
    });

    if (!conversation || !this.isParticipant(conversation, userId)) {
      throw ApiException.notFound('Conversation not found');
    }

    if (conversation.status === ConversationStatus.BLOCKED) {
      throw ApiException.forbidden('This conversation is closed');
    }

    /*
     * Upsert keyed on the idempotency pair.
     *
     * `update: {}` rather than a plain create: a replayed outbox entry returns
     * the original message instead of failing, so the client's queue can retry
     * blindly and converge rather than having to know which ones landed.
     */
    const message = await this.prisma.message.upsert({
      where: {
        conversationId_clientMessageId: {
          conversationId: id,
          clientMessageId: parsed.data.clientMessageId,
        },
      },
      create: {
        conversationId: id,
        senderId: userId,
        body: parsed.data.body,
        clientMessageId: parsed.data.clientMessageId,
        moderationStatus: ModerationStatus.PENDING,
      },
      update: {},
      select: { id: true, createdAt: true, moderationStatus: true, body: true },
    });

    // Only bump the thread preview once a genuinely new message lands, or a
    // replay would reorder the conversation list for no reason.
    if (message.moderationStatus === ModerationStatus.PENDING) {
      await this.prisma.conversation.update({
        where: { id },
        data: {
          lastMessageAt: message.createdAt,
          lastMessagePreview: parsed.data.body.slice(0, 200),
        },
      }).catch(() => undefined);
    }

    return {
      id: message.id,
      createdAt: message.createdAt.toISOString(),
      moderationStatus: message.moderationStatus,
      body: message.body,
    };
  }

  /** Opens a thread without requiring a prior reveal. */
  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Open a conversation about a listing' })
  async open(@Body() body: unknown, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const parsed = z.object({ listingId: z.string().cuid() }).safeParse(body);
    if (!parsed.success) {
      throw ApiException.validation([{ path: 'listingId', message: 'A listing is required' }]);
    }

    const listing = await this.prisma.listing.findUnique({
      where: { id: parsed.data.listingId },
      select: { id: true, posterId: true, status: true },
    });

    if (!listing || listing.status !== 'LIVE') throw ApiException.notFound('Listing not found');

    // Messaging yourself is not an error, it is the poster previewing the thread
    // on their own listing. Returning their own conversation is useful and keeps
    // the client from needing to special-case it.
    if (listing.posterId === userId) {
      throw ApiException.forbidden('This is your own listing');
    }

    const conversation = await this.prisma.conversation.upsert({
      where: { listingId_initiatorId: { listingId: listing.id, initiatorId: userId } },
      create: { listingId: listing.id, initiatorId: userId, ownerId: listing.posterId },
      update: {},
      select: { id: true },
    });

    return { id: conversation.id };
  }

  @Post('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a conversation as read up to now' })
  async markRead(@Param('id') id: string, @Req() req: FastifyRequest) {
    const userId = this.userId(req);

    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      select: { id: true, initiatorId: true, ownerId: true },
    });
    if (!conversation || !this.isParticipant(conversation, userId)) {
      throw ApiException.notFound('Conversation not found');
    }

    /*
     * Watermark from the newest message, not a timestamp.
     *
     * A timestamp can straddle a message sent between the read and the write, and
     * that message would then never be marked read. The message id is exact.
     */
    const latest = await this.prisma.message.findFirst({
      where: { conversationId: id, deletedAt: null, senderId: { not: userId } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    await this.prisma.messageRead.upsert({
      where: { conversationId_userId: { conversationId: id, userId } },
      create: {
        conversationId: id,
        userId,
        lastReadMessageId: latest?.id ?? null,
        lastReadAt: new Date(),
      },
      update: {
        lastReadMessageId: latest?.id ?? null,
        lastReadAt: new Date(),
      },
    });

    return { ok: true };
  }

  /**
   * How many messages each conversation has that this viewer has not read.
   *
   * Three batched queries for the whole inbox rather than a count per row. A
   * message counts as unread when the other party sent it, it passed moderation,
   * and it was created after the viewer's read watermark.
   *
   * A conversation with no watermark falls back to the thread's own last activity
   * time, so only messages that arrived after the thread went quiet count. An
   * earlier version returned the total message count whenever no watermark
   * existed, which meant every conversation ever opened looked unread forever.
   *
   * Conversations with nothing unread are absent from the map, so callers default
   * to zero rather than treating undefined as a count.
   */
  private async unreadByConversation(
    userId: string,
    conversationIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (conversationIds.length === 0) return result;

    const thread = await this.prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      select: {
        id: true,
        createdAt: true,
        reads: {
          where: { userId },
          select: { lastReadMessageId: true },
        },
      },
    });

    // Cutoff per conversation: the timestamp of the viewer's own last-read
    // message, or the conversation's creation time when they have never read it.
    const cutoffs = new Map<string, number>();
    const watermarkIds: string[] = [];

    for (const c of thread) {
      const id = c.reads[0]?.lastReadMessageId;
      if (id) {
        watermarkIds.push(id);
        // Resolved below; seeded so an unresolvable watermark cannot silently
        // count every message in the thread.
        cutoffs.set(c.id, Number.NEGATIVE_INFINITY);
      } else {
        /*
         * `createdAt`, never `lastMessageAt`.
         *
         * Using last activity as the cutoff looks reasonable and is silently
         * wrong: the newest message *is* what sets lastMessageAt, so it is never
         * strictly after the cutoff and the reply you most want to see is the one
         * thing that never shows as unread. Since only the other party's messages
         * are counted, starting from thread creation gives the correct answer for
         * a thread nobody has opened.
         */
        cutoffs.set(c.id, c.createdAt.getTime());
      }
    }

    if (watermarkIds.length > 0) {
      const marks = await this.prisma.message.findMany({
        where: { id: { in: watermarkIds } },
        select: { id: true, createdAt: true },
      });
      const markAt = new Map(marks.map((m) => [m.id, m.createdAt.getTime()]));
      for (const c of thread) {
        const id = c.reads[0]?.lastReadMessageId;
        if (!id) continue;
        // A watermark whose message has been deleted falls back to thread
        // creation, which over-counts rather than silently hiding a reply.
        cutoffs.set(c.id, markAt.get(id) ?? c.createdAt.getTime());
      }
    }

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId: { in: conversationIds },
        deletedAt: null,
        // Your own messages are never unread to you.
        senderId: { not: userId },
        // Unmoderated content is not delivered, so it is not unread either.
        moderationStatus: ModerationStatus.CLEAR,
      },
      select: { conversationId: true, createdAt: true },
    });

    for (const m of messages) {
      const cutoff = cutoffs.get(m.conversationId);
      if (cutoff === undefined) continue;
      if (m.createdAt.getTime() > cutoff) {
        result.set(m.conversationId, (result.get(m.conversationId) ?? 0) + 1);
      }
    }

    return result;
  }

  private isParticipant(
    conversation: { initiatorId: string; ownerId: string },
    userId: string,
  ): boolean {
    return conversation.initiatorId === userId || conversation.ownerId === userId;
  }

  /**
   * A pending or rejected message is only visible to whoever sent it.
   *
   * The sender still sees their own text so the thread does not appear to lose
   * messages on a retry, but flagged and rejected content is never delivered.
   */
  private isVisibleTo(
    message: { senderId: string; moderationStatus: ModerationStatus },
    userId: string,
  ): boolean {
    if (message.senderId === userId) return true;
    return message.moderationStatus === ModerationStatus.CLEAR;
  }

  private userId(req: FastifyRequest): string {
    const sub = (req as AuthenticatedRequest).user?.sub;
    if (!sub) throw ApiException.unauthenticated();
    return sub;
  }
}