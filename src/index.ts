/**
 * Standalone Streaming Service
 * Independent Express app for audio streaming service
 */
import './config/env';
import './types/session'; // Load session type extensions
import cors from 'cors';
import session from 'express-session';
import express from 'express';
import helmet from 'helmet';
import { config } from './config/env';
import { logger, errorLogger } from './config/logger';
import { apiLoggerMiddleware } from './middleware/ApiLoggerMiddleware';
import { apiErrorLogMiddleware } from './middleware/ApiErrorLogMiddleware';
import { ErrorHandler } from './middleware/ErrorHandler';
import { requireHealthSupportAuth } from './middleware/healthSupportAuth';
import { RabbitMQFactory } from './config/rabbitmq';
import { TranscodingWorkerFactory } from './workers/TranscodingWorker';
import { ChapterDeletionWorkerFactory } from './workers/ChapterDeletionWorker';
import { BullWorkerLauncher } from './workers/BullWorkerLauncher';
import { BullBoardManager } from './config/bullBoard';
import { createStreamingRoutes } from './routes/streamingRoutes';
import { setupSwagger } from './config/swagger';
import { PrismaClient } from '@prisma/client';
import { adapter } from './config/prisma.config';
import path from 'path';

process.on('uncaughtException', (err) => {
   errorLogger.error({ category: 'system', type: 'uncaughtException', err }, 'Uncaught exception');
   process.exit(1);
});

process.on('unhandledRejection', (reason) => {
   errorLogger.error({ category: 'system', type: 'unhandledRejection', err: reason }, 'Unhandled rejection');
});

const app = express();

if (config.TRUST_PROXY > 0) {
   app.set('trust proxy', config.TRUST_PROXY);
}

// Middleware
app.use(helmet());
app.use(cors({
   origin: true,
   credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(apiLoggerMiddleware);
app.use(apiErrorLogMiddleware);

// Session configuration
app.use(session({
   secret: config.SESSION_SECRET,
   resave: false,
   saveUninitialized: false,
   cookie: {
      secure: config.USE_SECURE_COOKIES,
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
   }
}));

// Serve transcoded segments statically in development only
if (config.NODE_ENV === 'development') {
   app.use(
      '/bit_transcode',
      express.static(path.join(process.cwd(), config.LOCAL_STORAGE_PATH, 'bit_transcode'))
   );
}

// Session validation middleware (exclude Bull Board and streaming routes)
app.use((req, res, next) => {
   // Skip session validation for Bull Board routes
   if (req.path.startsWith('/admin/queues')) {
      return next();
   }

   // Skip session validation for streaming routes (they use external service auth)
   if (req.path.startsWith('/api/v1/stream')) {
      return next();
   }

   next();
});

// Initialize Prisma client with adapter
const prisma = new PrismaClient({ adapter });

// Initialize RabbitMQ, storage provider, and transcoding worker
(async (): Promise<void> => {
   try {
      // Initialize storage provider first
      const { StorageFactory } = require('./services/storage/StorageFactory');
      await StorageFactory.initialize();
      logger.info('Storage provider initialized successfully');

      await RabbitMQFactory.initialize();
      logger.info('RabbitMQ initialized successfully');

      // Start transcoding worker
      await TranscodingWorkerFactory.startWorker(prisma);

      // Start chapter deletion worker
      await ChapterDeletionWorkerFactory.startWorker(prisma);

      // Start Bull workers
      const bullWorkerLauncher = BullWorkerLauncher.getInstance(prisma);
      await bullWorkerLauncher.start();

      // Initialize Bull Board
      const bullBoardManager = BullBoardManager.getInstance(prisma);
      await bullBoardManager.initialize();
   } catch (error) {
      logger.error({ err: error }, 'Failed to initialize services');
   }
})();

// Streaming Routes
app.use('/api/v1/stream', createStreamingRoutes(prisma));

setupSwagger(app);

// Bull Board Dashboard (Unauthorized access for now)
const bullBoardManager = BullBoardManager.getInstance(prisma);
app.use(bullBoardManager.getBasePath(), bullBoardManager.getRouter());

// Health check endpoint — separate support auth (not JWT)
app.get('/api/stream/health', requireHealthSupportAuth, async (_req, res) => {
   try {
      const healthStatus = {
         status: 'healthy',
         service: 'audio-streaming',
         timestamp: new Date().toISOString(),
         components: {
            database: false,
            redis: false,
            rabbitmq: false,
            storage: false,
            ffmpeg: false,
            bullWorkers: false
         }
      };

      // Test database connection
      try {
         await prisma.$queryRaw`SELECT 1`;
         healthStatus.components.database = true;
      } catch (error) {
         logger.error({ err: error }, 'Database health check failed');
      }

      // Test Redis connection
      try {
         const redis = require('./config/redis').RedisConnection.getInstance();
         healthStatus.components.redis = await redis.testConnection();
      } catch (error) {
         logger.error({ err: error }, 'Redis health check failed');
      }

      // Test RabbitMQ connection
      try {
         const rabbitMQ = RabbitMQFactory.getConnection();
         healthStatus.components.rabbitmq = rabbitMQ.isConnected();
      } catch (error) {
         logger.error({ err: error }, 'RabbitMQ health check failed');
      }

      // Test storage provider
      try {
         const storageProvider = require('./services/storage/StorageFactory').StorageFactory.getStorageProvider();
         healthStatus.components.storage = await storageProvider.testConnection();
      } catch (error) {
         logger.error({ err: error }, 'Storage health check failed');
      }

      // Test FFmpeg
      try {
         const transcodingService = require('./services/TranscodingService').TranscodingService;
         const service = new transcodingService(prisma);
         healthStatus.components.ffmpeg = await service.testFFmpegInstallation();
      } catch (error) {
         logger.error({ err: error }, 'FFmpeg health check failed');
      }

      // Test Bull workers
      try {
         const bullWorkerLauncher = BullWorkerLauncher.getInstance(prisma);
         healthStatus.components.bullWorkers = bullWorkerLauncher.isReady();
      } catch (error) {
         logger.error({ err: error }, 'Bull workers health check failed');
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
         service: 'audio-streaming',
         error: error.message,
         timestamp: new Date().toISOString()
      });
   }
});

// Service info endpoint
app.get('/', (_req, res) => {
   res.json({
      service: 'Audio Streaming Service',
      version: '1.0.0',
      status: 'running',
      timestamp: new Date().toISOString(),
      endpoints: {
         health: '/api/stream/health',
         apiDocs: '/api-docs',
         openApiSpec: '/api-docs.json',
         streaming: '/api/v1/stream',
         masterPlaylist: '/api/v1/stream/chapters/:chapterId/master.m3u8',
         variantPlaylist: '/api/v1/stream/chapters/:chapterId/:bitrate/playlist.m3u8',
         segment: '/api/v1/stream/chapters/:chapterId/:bitrate/segments/:segmentId',
         status: '/api/v1/stream/chapters/:chapterId/status',
         transcoding: '/api/v1/stream/chapters/:chapterId/transcoding',
         transcodingEvents: '/api/v1/stream/chapters/:chapterId/transcoding/events',
         multiplexedTranscodingEvents: '/api/v1/stream/transcoding/events?chapterIds=',
         transcodeRetry: '/api/v1/stream/chapters/:chapterId/transcode/retry',
         preload: '/api/v1/stream/chapters/:chapterId/preload',
         analytics: '/api/v1/stream/analytics',
         bullBoard: '/admin/queues'
      }
   });
});

// 404 handler for undefined routes
app.use((req, res) => ErrorHandler.handleNotFound(req, res));

// Global error handler
app.use(ErrorHandler.handleError);

// Store server instance for graceful shutdown
// eslint-disable-next-line prefer-const
let server: ReturnType<typeof app.listen> | undefined;

// Graceful shutdown function
const gracefulShutdown = async (signal: string) => {
   logger.info({ signal }, 'Received signal, shutting down gracefully');

   try {
      // Stop accepting new connections
      if (server) {
         server.close(() => {
            logger.info('HTTP server closed');
         });
      }

      // Stop transcoding worker
      await TranscodingWorkerFactory.stopWorker();
      logger.info('Transcoding worker stopped');

      // Stop chapter deletion worker
      await ChapterDeletionWorkerFactory.stopWorker();
      logger.info('Chapter deletion worker stopped');

      // Stop Bull workers
      const bullWorkerLauncher = BullWorkerLauncher.getInstance(prisma);
      await bullWorkerLauncher.stop();
      logger.info('Bull workers stopped');

      // Close RabbitMQ connection
      await RabbitMQFactory.shutdown();
      logger.info('RabbitMQ connection closed');

      // Close Prisma connection
      await prisma.$disconnect();
      logger.info('Database connection closed');

      logger.info('Graceful shutdown completed');
      process.exit(0);
   } catch (error) {
      logger.error({ err: error }, 'Error during graceful shutdown');
      process.exit(1);
   }
};

// Graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle nodemon restart
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));

// Start server
const port = config.PORT;
server = app.listen(port, () => {
   logger.info({ port }, 'Audio Streaming Service running on port');
   logger.info({ nodeEnv: config.NODE_ENV }, 'Environment');
   logger.info({ serviceUrl: `http://localhost:${port}` }, 'Service URL');
   logger.info({ healthCheckUrl: `http://localhost:${port}/api/stream/health` }, 'Health Check URL');
   logger.info({ swaggerUI: `http://localhost:${port}/api-docs`, openAPISpec: `http://localhost:${port}/api-docs.json` }, 'API documentation');
   logger.info({ streamingApiUrl: `http://localhost:${port}/api/v1/stream` }, 'Streaming API URL');
   logger.info({ bullBoardUrl: `http://localhost:${port}/admin/queues` }, 'Bull Board URL');
}).on('error', (err: any) => {
   if (err.code === 'EADDRINUSE') {
      logger.error({ port }, 'Port is already in use. Please kill the existing process or use a different port');
      logger.error({ port, hint: `netstat -ano | findstr :${port}` }, 'Find the process using this port');
      process.exit(1);
   } else {
      logger.error({ err }, 'Server error');
      process.exit(1);
   }
});
