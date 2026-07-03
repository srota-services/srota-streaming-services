/**
 * Chapter Deletion Worker
 * RabbitMQ consumer for processing chapter deletion messages
 * Cleans up transcoding jobs, cache, storage artifacts, and DB records
 */
import { RabbitMQFactory, ChapterDeletionMessage, getChapterDeletionQueueName } from '../config/rabbitmq';
import { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger';
import { BullQueueManager } from '../services/BullQueueManager';
import { StreamingCacheFactory } from '../services/StreamingCacheService';
import { TranscodingArtifactCleanupService } from '../services/TranscodingArtifactCleanupService';
import { runInTransaction } from '../utils/prismaTransaction';
import { rethrowServiceError } from '../utils/serviceError';

export class ChapterDeletionWorker {
   private prisma: PrismaClient;
   private bullQueueManager: BullQueueManager;
   private isRunning = false;

   constructor(prisma: PrismaClient) {
      this.prisma = prisma;
      this.bullQueueManager = BullQueueManager.getInstance(prisma);
   }

   /**
    * Start the chapter deletion worker
    */
   async start(): Promise<void> {
      if (this.isRunning) {
         logger.info('Chapter deletion worker is already running');
         return;
      }

      try {
         await RabbitMQFactory.initialize();

         logger.info('Starting chapter deletion worker...');
         await this.startConsumer();

         this.isRunning = true;
         logger.info('Chapter deletion worker started successfully');
      } catch (error: unknown) {
         logger.error({ err: error }, 'Failed to start chapter deletion worker');
         throw error;
      }
   }

   /**
    * Stop the chapter deletion worker
    */
   async stop(): Promise<void> {
      if (!this.isRunning) {
         logger.info('Chapter deletion worker is not running');
         return;
      }

      try {
         this.isRunning = false;
         logger.info('Chapter deletion worker stopped');
      } catch (error: unknown) {
         logger.error({ err: error }, 'Error stopping chapter deletion worker');
      }
   }

   private async startConsumer(): Promise<void> {
      try {
         const rabbitMQ = RabbitMQFactory.getConnection();

         await rabbitMQ.consume<ChapterDeletionMessage>(
            getChapterDeletionQueueName(),
            async (messageData: ChapterDeletionMessage, message) => {
               await this.processChapterDeletion(messageData, message);
            }
         );

         logger.info({ queueName: getChapterDeletionQueueName() }, 'Started consuming chapter deletion messages');
      } catch (error: unknown) {
         logger.error({ err: error }, 'Error starting consumer for chapter deletion queue');
         throw error;
      }
   }

   /**
    * Process chapter deletion message
    */
   private async processChapterDeletion(
      messageData: ChapterDeletionMessage,
      _message: unknown
   ): Promise<void> {
      const { chapterId, timestamp } = messageData;

      logger.info({ chapterId, timestamp }, 'Processing chapter deletion for chapterId');

      if (!chapterId || typeof chapterId !== 'string') {
         throw new Error(`Invalid chapterId in deletion message: ${chapterId}`);
      }

      try {
         try {
            await this.bullQueueManager.removeJobsForChapter(chapterId);
         } catch (error: unknown) {
            logger.warn({ err: error, chapterId }, 'Failed to remove Bull jobs for deleted chapter');
         }

         try {
            await StreamingCacheFactory.getInstance().clearChapterCache(chapterId);
         } catch (error: unknown) {
            logger.warn({ err: error, chapterId }, 'Failed to clear streaming cache for deleted chapter');
         }

         await TranscodingArtifactCleanupService.cleanupChapterArtifacts(chapterId);

         try {
            const { transcodingJobsResult, sessionsResult, deleteResult } = await runInTransaction(
               this.prisma,
               async tx => {
                  const transcodingJobsResult = await tx.transcodingJob.deleteMany({
                     where: { chapterId },
                  });
                  const sessionsResult = await tx.streamingSession.deleteMany({
                     where: { chapterId },
                  });
                  const deleteResult = await tx.transcodedChapter.deleteMany({
                     where: { chapterId },
                  });
                  return { transcodingJobsResult, sessionsResult, deleteResult };
               },
            );

            if (transcodingJobsResult.count > 0) {
               logger.info({ chapterId, count: transcodingJobsResult.count }, 'Deleted transcoding job(s) for chapter');
            }

            if (sessionsResult.count > 0) {
               logger.info({ chapterId, count: sessionsResult.count }, 'Deleted streaming session(s) for chapter');
            }

            logger.info(
               { chapterId, count: deleteResult.count },
               'Successfully completed chapter deletion cleanup'
            );
         } catch (error: unknown) {
            rethrowServiceError(error, { operation: 'processChapterDeletionDbCleanup', chapterId });
         }
      } catch (error: unknown) {
         logger.error({ err: error, chapterId }, 'Error during chapter deletion cleanup');
         throw error;
      }
   }

   async getWorkerStatus(): Promise<{
      isRunning: boolean;
      queueName: string;
   }> {
      return {
         isRunning: this.isRunning,
         queueName: getChapterDeletionQueueName(),
      };
   }

   async testWorker(): Promise<boolean> {
      try {
         const rabbitMQ = RabbitMQFactory.getConnection();
         const isConnected = rabbitMQ.isConnected();

         await this.prisma.$queryRaw`SELECT 1`;

         logger.info({
            rabbitMQConnected: isConnected,
            databaseConnected: true,
         }, 'Chapter deletion worker test results');

         return isConnected;
      } catch (error: unknown) {
         logger.error({ err: error }, 'Chapter deletion worker test failed');
         return false;
      }
   }
}

/**
 * Worker factory for easy access
 */
export class ChapterDeletionWorkerFactory {
   private static worker: ChapterDeletionWorker | null = null;

   public static getWorker(prisma: PrismaClient): ChapterDeletionWorker {
      if (!ChapterDeletionWorkerFactory.worker) {
         ChapterDeletionWorkerFactory.worker = new ChapterDeletionWorker(prisma);
      }
      return ChapterDeletionWorkerFactory.worker;
   }

   public static async startWorker(prisma: PrismaClient): Promise<void> {
      const worker = ChapterDeletionWorkerFactory.getWorker(prisma);
      await worker.start();
   }

   public static async stopWorker(): Promise<void> {
      if (ChapterDeletionWorkerFactory.worker) {
         await ChapterDeletionWorkerFactory.worker.stop();
         ChapterDeletionWorkerFactory.worker = null;
      }
   }
}
