/**
 * Streaming Controller
 * Handles HTTP requests for audio streaming endpoints
 */
import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { HLSStreamingService, StreamingOptions } from '../services/HLSStreamingService';
import { TranscodingService } from '../services/TranscodingService';
import { ErrorHandler } from '../middleware/ErrorHandler';
import { ResponseHandler } from '../utils/ResponseHandler';
import { MessageHandler } from '../utils/MessageHandler';
import { logger } from '../config/logger';
import { isNonEmptyChapterId, isNumericBitrate } from '../utils/streamingValidation';

export class StreamingController {
   private prisma: PrismaClient;
   private streamingService: HLSStreamingService;
   private transcodingService: TranscodingService;

   constructor(prisma: PrismaClient) {
      this.prisma = prisma;
      this.streamingService = new HLSStreamingService(prisma);
      this.transcodingService = new TranscodingService(prisma);
   }

   /**
    * @swagger
    * /api/v1/stream/chapters/{chapterId}/master.m3u8:
    *   get:
    *     summary: Get master HLS playlist for chapter
    *     description: Returns the master playlist containing all available bitrates for a chapter
    *     tags: [Streaming]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterId
    *         in: path
    *         required: true
    *         schema:
    *           type: string
    *         description: Chapter ID
    *       - name: bandwidth
    *         in: query
    *         required: false
    *         schema:
    *           type: integer
    *           example: 500000
    *         description: Optional client bandwidth in bps (for bitrate selection)
    *       - name: bitrate
    *         in: query
    *         required: false
    *         schema:
    *           type: integer
    *           example: 128
    *         description: Optional preferred bitrate in kbps
    *     responses:
    *       200:
    *         description: Master playlist returned successfully
    *         content:
    *           application/vnd.apple.mpegurl:
    *             schema:
    *               type: string
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    *       404:
    *         description: Chapter not found or no transcoded versions available
    *       500:
    *         description: Internal server error
    */
   getMasterPlaylist = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const chapterId = req.params['chapterId'] as string;
      const userId = (req as any).user?.id;
      const clientBandwidth = req.query['bandwidth'] ? parseInt(req.query['bandwidth'] as string, 10) : undefined;
      const preferredBitrate = req.query['bitrate'] ? parseInt(req.query['bitrate'] as string, 10) : undefined;

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      if (!isNonEmptyChapterId(chapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      if (preferredBitrate !== undefined && !isNumericBitrate(preferredBitrate)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_bitrate'));
         return;
      }

      const streamingOptions: StreamingOptions = {
         chapterId,
         userId,
         ...(clientBandwidth !== undefined && { clientBandwidth }),
         ...(preferredBitrate !== undefined && { preferredBitrate })
      };

      const response = await this.streamingService.getMasterPlaylist(streamingOptions);

      // Set response headers
      Object.entries(response.headers).forEach(([key, value]) => {
         res.setHeader(key, value);
      });

      res.status(response.statusCode).send(response.content);
   });

   /**
    * @swagger
    * /api/v1/stream/chapters/{chapterId}/{bitrate}/playlist.m3u8:
    *   get:
    *     summary: Get variant HLS playlist for specific bitrate
    *     description: Returns the variant playlist for a specific bitrate containing segment information
    *     tags: [Streaming]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterId
    *         in: path
    *         required: true
    *         schema:
    *           type: string
    *         description: Chapter ID
    *       - name: bitrate
    *         in: path
    *         required: true
    *         schema:
    *           type: integer
    *         description: Bitrate in kbps
    *     responses:
    *       200:
    *         description: Variant playlist returned successfully
    *         content:
    *           application/vnd.apple.mpegurl:
    *             schema:
    *               type: string
    *       400:
    *         description: Invalid bitrate path parameter
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    *       404:
    *         description: Chapter not found or transcoded version not available
    *       500:
    *         description: Internal server error
    */
   getVariantPlaylist = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const chapterId = req.params['chapterId'] as string;
      const bitrate = parseInt(req.params['bitrate'] as string, 10);
      const userId = (req as any).user?.id;

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      if (!isNonEmptyChapterId(chapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      if (isNaN(bitrate) || !isNumericBitrate(bitrate)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_bitrate'));
         return;
      }

      const response = await this.streamingService.getVariantPlaylist(chapterId, bitrate);

      // Set response headers
      Object.entries(response.headers).forEach(([key, value]) => {
         res.setHeader(key, value);
      });

      res.status(response.statusCode).send(response.content);
   });

   /**
    * @swagger
    * /api/v1/stream/chapters/{chapterId}/{bitrate}/segments/{segmentId}:
    *   get:
    *     summary: Get HLS segment
    *     description: Returns a specific HLS segment file for streaming
    *     tags: [Streaming]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterId
    *         in: path
    *         required: true
    *         schema:
    *           type: string
    *         description: Chapter ID
    *       - name: bitrate
    *         in: path
    *         required: true
    *         schema:
    *           type: integer
    *         description: Bitrate in kbps
    *       - name: segmentId
    *         in: path
    *         required: true
    *         schema:
    *           type: string
    *           example: segment_001.m4s
    *         description: Segment filename (e.g. segment_001.m4s or segment_001.ts)
    *     responses:
    *       200:
    *         description: Segment returned successfully
    *         content:
    *           video/mp4:
    *             schema:
    *               type: string
    *               format: binary
    *           video/mp2t:
    *             schema:
    *               type: string
    *               format: binary
    *       400:
    *         description: Invalid bitrate path parameter
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    *       404:
    *         description: Segment not found
    *       500:
    *         description: Internal server error
    */
   getSegment = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const chapterId = req.params['chapterId'] as string;
      const bitrate = parseInt(req.params['bitrate'] as string, 10);
      const segmentId = req.params['segmentId'] as string;
      const userId = (req as any).user?.id;

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      if (!isNonEmptyChapterId(chapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      if (isNaN(bitrate) || !isNumericBitrate(bitrate)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_bitrate'));
         return;
      }

      const response = await this.streamingService.getSegment(chapterId, bitrate, segmentId);

      Object.entries(response.headers).forEach(([key, value]) => {
         res.setHeader(key, value);
      });

      if (response.statusCode === 302 && response.headers['Location']) {
         res.redirect(302, response.headers['Location']);
         return;
      }

      res.status(response.statusCode).send(response.content);
   });

   /**
    * @swagger
    * /api/v1/stream/chapters/{chapterId}/status:
    *   get:
    *     summary: Get streaming status for chapter
    *     description: Returns the current streaming status and available bitrates for a chapter
    *     tags: [Streaming]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterId
    *         in: path
    *         required: true
    *         schema:
    *           type: string
    *         description: Chapter ID
    *     responses:
    *       200:
    *         description: Streaming status retrieved successfully
    *         content:
    *           application/json:
    *             schema:
    *               allOf:
    *                 - $ref: '#/components/schemas/ApiResponse'
    *                 - type: object
    *                   properties:
    *                     data:
    *                       $ref: '#/components/schemas/StreamingStatus'
    *             examples:
    *               ready:
    *                 summary: Chapter ready to stream
    *                 value:
    *                   success: true
    *                   message: "Streaming status retrieved"
    *                   data:
    *                     chapterId: "cchapter1234567890abcdef"
    *                     availableBitrates: [64, 128, 192]
    *                     transcodingStatus: "completed"
    *                     canStream: true
    *                     estimatedBandwidth: 192000
    *                   timestamp: "2024-01-15T10:30:00Z"
    *                   statusCode: 200
    *               notReady:
    *                 summary: Chapter not yet transcoded
    *                 value:
    *                   success: true
    *                   message: "Streaming status retrieved"
    *                   data:
    *                     chapterId: "cchapter1234567890abcdef"
    *                     availableBitrates: []
    *                     transcodingStatus: "pending"
    *                     canStream: false
    *                     estimatedBandwidth: 0
    *                   timestamp: "2024-01-15T10:30:00Z"
    *                   statusCode: 200
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    *       500:
    *         description: Internal server error
    */
   getStreamingStatus = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const chapterId = req.params['chapterId'] as string;
      const userId = (req as any).user?.id;

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      if (!isNonEmptyChapterId(chapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      const status = await this.streamingService.getStreamingStatus(chapterId);

      ResponseHandler.success(res, status, MessageHandler.getStreamingMessageFromRequest(req, 'status_retrieved'));
   });

   /**
    * @swagger
    * /api/v1/stream/chapters/{chapterId}/preload:
    *   post:
    *     summary: Preload chapter for streaming
    *     description: Preloads chapter segments into cache for faster streaming
    *     tags: [Streaming]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterId
    *         in: path
    *         required: true
    *         schema:
    *           type: string
    *         description: Chapter ID
    *     requestBody:
    *       required: false
    *       content:
    *         application/json:
    *           schema:
    *             type: object
    *             properties:
    *               bitrate:
    *                 type: integer
    *                 example: 128
    *                 description: Optional bitrate in kbps (defaults to highest available)
    *           examples:
    *             defaultBitrate:
    *               summary: Preload with default (highest) bitrate
    *               value: {}
    *             specificBitrate:
    *               summary: Preload specific bitrate
    *               value:
    *                 bitrate: 128
    *     responses:
    *       200:
    *         description: Preload initiated successfully
    *         content:
    *           application/json:
    *             schema:
    *               allOf:
    *                 - $ref: '#/components/schemas/ApiResponse'
    *                 - type: object
    *                   properties:
    *                     data:
    *                       $ref: '#/components/schemas/PreloadResult'
    *             example:
    *               success: true
    *               message: "Chapter preloaded"
    *               data:
    *                 chapterId: "cchapter1234567890abcdef"
    *                 bitrate: 128
    *                 status: "preloaded"
    *               timestamp: "2024-01-15T10:30:00Z"
    *               statusCode: 200
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    *       404:
    *         $ref: '#/components/responses/NotFound'
    *       500:
    *         description: Internal server error
    */
   preloadChapter = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const chapterId = req.params['chapterId'] as string;
      const userId = (req as any).user?.id;
      const { bitrate } = req.body;

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      if (!isNonEmptyChapterId(chapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      if (bitrate !== undefined && !isNumericBitrate(bitrate)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_bitrate'));
         return;
      }

      // Get available bitrates if not specified
      let targetBitrate = bitrate;
      if (!targetBitrate) {
         const availableBitrates = await this.streamingService.getAvailableBitrates(chapterId);
         if (availableBitrates.length === 0) {
            ResponseHandler.notFound(res, MessageHandler.getStreamingMessageFromRequest(req, 'no_bitrates_available'));
            return;
         }
         targetBitrate = Math.max(...availableBitrates);
      }

      const success = await this.streamingService.preloadChapter(chapterId, targetBitrate);

      if (!success) {
         ResponseHandler.notFound(res, MessageHandler.getStreamingMessageFromRequest(req, 'preload_failed'));
         return;
      }

      ResponseHandler.success(res, {
         chapterId,
         bitrate: targetBitrate,
         status: 'preloaded'
      }, MessageHandler.getStreamingMessageFromRequest(req, 'preloaded'));
   });

   /**
    * @swagger
    * /api/v1/stream/analytics:
    *   get:
    *     summary: Get streaming analytics
    *     description: Returns streaming performance and usage analytics
    *     tags: [Analytics]
    *     security:
    *       - bearerAuth: []
    *     parameters:
    *       - name: chapterId
    *         in: query
    *         required: false
    *         schema:
    *           type: string
    *           example: "cchapter1234567890abcdef"
    *         description: Optional chapter ID to get chapter-specific analytics (omit for global analytics)
    *     responses:
    *       200:
    *         description: Analytics retrieved successfully
    *         content:
    *           application/json:
    *             schema:
    *               allOf:
    *                 - $ref: '#/components/schemas/ApiResponse'
    *                 - type: object
    *                   properties:
    *                     data:
    *                       $ref: '#/components/schemas/StreamingAnalytics'
    *             example:
    *               success: true
    *               message: "Analytics retrieved"
    *               data:
    *                 totalRequests: 1000
    *                 cacheHitRate: 0.85
    *                 averageBandwidth: 128000
    *                 popularBitrates:
    *                   - bitrate: 128
    *                     requests: 42
    *               timestamp: "2024-01-15T10:30:00Z"
    *               statusCode: 200
    *       401:
    *         $ref: '#/components/responses/Unauthorized'
    *       500:
    *         description: Internal server error
    */
   getAnalytics = ErrorHandler.asyncHandler(async (req: Request, res: Response): Promise<void> => {
      const userId = (req as any).user?.id;
      const chapterId = req.query['chapterId'] as string;

      if (!userId) {
         ResponseHandler.unauthorized(res, MessageHandler.getUnauthorizedMessageFromRequest(req, 'not_authenticated'));
         return;
      }

      if (chapterId && !isNonEmptyChapterId(chapterId)) {
         ResponseHandler.validationError(res, MessageHandler.getValidationMessageFromRequest(req, 'invalid_chapter_id'));
         return;
      }

      let analytics;
      if (chapterId) {
         analytics = await this.streamingService.getStreamingAnalytics(chapterId);
      } else {
         // Get global analytics
         analytics = await this.streamingService.getStreamingAnalytics('');
      }

      ResponseHandler.success(res, analytics, MessageHandler.getStreamingMessageFromRequest(req, 'analytics_retrieved'));
   });

   getHealthStatus = ErrorHandler.asyncHandler(async (_req: Request, res: Response): Promise<void> => {
      try {
         const healthStatus = {
            status: 'healthy',
            components: {
               database: false,
               redis: false,
               rabbitmq: false,
               storage: false,
               ffmpeg: false
            }
         };

         // Test database connection
         try {
            await this.prisma.$queryRaw`SELECT 1`;
            healthStatus.components.database = true;
         } catch (error) {
            logger.error({ err: error }, 'Database health check failed');
         }

         // Test Redis connection
         try {
            const redis = require('../config/redis').RedisConnection.getInstance();
            healthStatus.components.redis = await redis.testConnection();
         } catch (error) {
            logger.error({ err: error }, 'Redis health check failed');
         }

         // Test storage provider
         try {
            const storageProvider = require('../services/storage/StorageFactory').StorageFactory.getStorageProvider();
            healthStatus.components.storage = await storageProvider.testConnection();
         } catch (error) {
            logger.error({ err: error }, 'Storage health check failed');
         }

         // Test FFmpeg
         try {
            healthStatus.components.ffmpeg = await this.transcodingService.testFFmpegInstallation();
         } catch (error) {
            logger.error({ err: error }, 'FFmpeg health check failed');
         }

         // Determine overall status
         const allHealthy = Object.values(healthStatus.components).every(status => status === true);
         healthStatus.status = allHealthy ? 'healthy' : 'degraded';

         const statusCode = allHealthy ? 200 : 503;
         res.status(statusCode).json(healthStatus);

      } catch (error: any) {
         logger.error({ err: error }, 'Health check failed');
         res.status(500).json({
            status: 'unhealthy',
            error: error.message
         });
      }
   });

}
