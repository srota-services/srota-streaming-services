import { PrismaClient } from '@prisma/client';
import { StreamingController } from '../controllers/StreamingController';
import { TranscodingEventsController } from '../controllers/TranscodingEventsController';
import { authenticateJWT } from '../middleware/authenticateJWT';
import {
   requireChapterStreamAccess,
   requireMultiplexChapterStreamAccess,
   requireQueryChapterStreamAccess,
} from '../middleware/StreamAccessMiddleware';

/**
 * Streaming routes factory
 * All routes require JWT authentication and LISTENER subscription gating where applicable
 */
export const createStreamingRoutes = (prisma: PrismaClient) => {
   const router = require('express').Router();
   const streamingController = new StreamingController(prisma);
   const transcodingEventsController = new TranscodingEventsController(prisma);

   router.use(authenticateJWT);

   // HLS Master playlist endpoint
   router.get(
      '/chapters/:chapterId/master.m3u8',
      requireChapterStreamAccess(),
      streamingController.getMasterPlaylist,
   );

   // HLS Variant playlist endpoint
   router.get(
      '/chapters/:chapterId/:bitrate/playlist.m3u8',
      requireChapterStreamAccess(),
      streamingController.getVariantPlaylist,
   );

   // HLS Segment endpoint
   router.get(
      '/chapters/:chapterId/:bitrate/segments/:segmentId',
      requireChapterStreamAccess(),
      streamingController.getSegment,
   );

   // Status endpoint
   router.get(
      '/chapters/:chapterId/status',
      requireChapterStreamAccess(),
      streamingController.getStreamingStatus,
   );

   // Detailed transcoding status
   router.get(
      '/chapters/:chapterId/transcoding',
      requireChapterStreamAccess(),
      transcodingEventsController.getDetailedTranscodingStatus,
   );

   // SSE transcoding events
   router.get(
      '/chapters/:chapterId/transcoding/events',
      requireChapterStreamAccess(),
      transcodingEventsController.getChapterTranscodingEvents,
   );
   router.get(
      '/transcoding/events',
      requireMultiplexChapterStreamAccess(),
      transcodingEventsController.getMultiplexedTranscodingEvents,
   );

   // Retry failed bitrates
   router.post(
      '/chapters/:chapterId/transcode/retry',
      requireChapterStreamAccess(),
      transcodingEventsController.retryTranscoding,
   );

   // Preload endpoint
   router.post(
      '/chapters/:chapterId/preload',
      requireChapterStreamAccess(),
      streamingController.preloadChapter,
   );

   // Analytics endpoint
   router.get(
      '/analytics',
      requireQueryChapterStreamAccess(),
      streamingController.getAnalytics,
   );

   return router;
};
