/**
 * Transcoding Events Controller
 * SSE endpoints for live per-bitrate transcoding progress
 */
import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { ErrorHandler } from '../middleware/ErrorHandler';
import { ResponseHandler } from '../utils/ResponseHandler';
import { MessageHandler } from '../utils/MessageHandler';
import { DetailedTranscodingService } from '../services/DetailedTranscodingService';
import { TranscodingEventPublisher } from '../services/TranscodingEventPublisher';
import { TranscodingRetryService } from '../services/TranscodingRetryService';
import { BullQueueManager } from '../services/BullQueueManager';
import { TranscodingEvent } from '../types/transcoding';
import { logger } from '../config/logger';
import { isNonEmptyChapterId, isNumericBitrate } from '../utils/streamingValidation';

const HEARTBEAT_MS = 30_000;

export class TranscodingEventsController {
   private readonly detailService: DetailedTranscodingService;
   private readonly eventPublisher: TranscodingEventPublisher;
   private readonly retryService: TranscodingRetryService;

   constructor(private readonly prisma: PrismaClient) {
      this.detailService = new DetailedTranscodingService(prisma);
      this.eventPublisher = TranscodingEventPublisher.getInstance();
      this.retryService = new TranscodingRetryService(
         prisma,
         BullQueueManager.getInstance(prisma)
      );
   }

   /**
    * @swagger
    * /api/v1/stream/chapters/{chapterId}/transcoding/events:
    *   get:
    *     summary: SSE stream for chapter transcoding events
    *     description: Server-Sent Events stream with live per-bitrate progress (0-100)
    *     tags: [Streaming]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterId
    *         in: path
    *         required: true
    *         schema: { type: string }
    *     responses:
    *       200:
    *         description: SSE stream (event types snapshot, transcoding)
    *         content:
    *           text/event-stream:
    *             schema:
    *               type: string
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    */
   getChapterTranscodingEvents = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const chapterId = req.params['chapterId'] as string;
      const userId = (req as Request & { user?: { id: string } }).user?.id;

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      if (!isNonEmptyChapterId(chapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      await this.streamEvents(res, [chapterId]);
   });

   /**
    * @swagger
    * /api/v1/stream/transcoding/events:
    *   get:
    *     summary: Multiplexed SSE for multiple chapters
    *     tags: [Streaming]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterIds
    *         in: query
    *         required: true
    *         schema: { type: string, example: 'ch1,ch2,ch3' }
    *     responses:
    *       200:
    *         description: SSE stream
    *         content:
    *           text/event-stream:
    *             schema: { type: string }
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    */
   getMultiplexedTranscodingEvents = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const userId = (req as Request & { user?: { id: string } }).user?.id;
      const chapterIdsParam = req.query['chapterIds'] as string | undefined;

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      const chapterIds = (chapterIdsParam ?? '')
         .split(',')
         .map(id => id.trim())
         .filter(Boolean);

      if (!chapterIds.length) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_request'));
         return;
      }

      if (!chapterIds.every(isNonEmptyChapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      await this.streamEvents(res, chapterIds);
   });

   /**
    * @swagger
    * /api/v1/stream/chapters/{chapterId}/transcoding:
    *   get:
    *     summary: Detailed per-bitrate transcoding status
    *     tags: [Streaming]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterId
    *         in: path
    *         required: true
    *         schema: { type: string }
    *     responses:
    *       200:
    *         description: Detailed status
    *         content:
    *           application/json:
    *             schema:
    *               allOf:
    *                 - $ref: '#/components/schemas/ApiResponse'
    *                 - type: object
    *                   properties:
    *                     data:
    *                       $ref: '#/components/schemas/ChapterTranscodingStatusDetail'
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    */
   getDetailedTranscodingStatus = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const chapterId = req.params['chapterId'] as string;
      const userId = (req as Request & { user?: { id: string } }).user?.id;

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      if (!isNonEmptyChapterId(chapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      const status = await this.detailService.getDetailedStatus(chapterId);
      ResponseHandler.success(res, status, MessageHandler.getStreamingMessageFromRequest(req, 'status_retrieved'));
   });

   /**
    * @swagger
    * /api/v1/stream/chapters/{chapterId}/transcode/retry:
    *   post:
    *     summary: Retry failed bitrates for a chapter
    *     tags: [Streaming]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterId
    *         in: path
    *         required: true
    *         schema: { type: string }
    *     requestBody:
    *       content:
    *         application/json:
    *           schema:
    *             $ref: '#/components/schemas/RetryTranscodingRequest'
    *     responses:
    *       200:
    *         description: Retry initiated
    *         content:
    *           application/json:
    *             schema:
    *               allOf:
    *                 - $ref: '#/components/schemas/ApiResponse'
    *                 - type: object
    *                   properties:
    *                     data:
    *                       type: object
    *                       properties:
    *                         retriedBitrates:
    *                           type: array
    *                           items: { type: integer }
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    */
   retryTranscoding = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const chapterId = req.params['chapterId'] as string;
      const userId = (req as Request & { user?: { id: string } }).user?.id;
      const { bitrates, inputPath } = req.body as { bitrates?: number[]; inputPath?: string };

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      if (!inputPath) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_request'));
         return;
      }

      if (!isNonEmptyChapterId(chapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      if (bitrates !== undefined && (!Array.isArray(bitrates) || !bitrates.every(isNumericBitrate))) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_bitrate'));
         return;
      }

      const result = await this.retryService.retryFailedBitrates({
         chapterId,
         bitrates,
         inputPath,
         userId,
      });

      ResponseHandler.success(res, result, MessageHandler.getStreamingMessageFromRequest(req, 'retry_initiated'));
   });

   private async streamEvents(res: Response, chapterIds: string[]): Promise<void> {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      for (const chapterId of chapterIds) {
         const snapshot = await this.detailService.getDetailedStatus(chapterId);
         res.write(`event: snapshot\n`);
         res.write(`data: ${JSON.stringify({
            chapterId,
            bitrates: snapshot.bitrates,
            timestamp: new Date().toISOString(),
         })}\n\n`);
      }

      const subscriber = this.eventPublisher.createSubscriber();
      const channels = chapterIds.map(id => TranscodingEventPublisher.channelForChapter(id));

      const onMessage = (channel: string, message: string): void => {
         try {
            const event = JSON.parse(message) as TranscodingEvent;
            if (!chapterIds.includes(event.chapterId)) {
               return;
            }
            res.write(`event: transcoding\n`);
            res.write(`data: ${JSON.stringify(event)}\n\n`);
         } catch (error) {
            logger.warn({ err: error, channel }, 'Invalid transcoding SSE message');
         }
      };

      await subscriber.subscribe(...channels);
      subscriber.on('message', onMessage);

      const heartbeat = setInterval(() => {
         res.write(`: heartbeat\n\n`);
      }, HEARTBEAT_MS);

      const cleanup = (): void => {
         clearInterval(heartbeat);
         subscriber.off('message', onMessage);
         void subscriber.unsubscribe(...channels);
         void subscriber.quit();
      };

      reqOnClose(res, cleanup);
   }
}

function reqOnClose(res: Response, cleanup: () => void): void {
   res.on('close', cleanup);
   res.on('error', cleanup);
}
