/**
 * Transcoding Worker
 * RabbitMQ consumer for processing audio transcoding jobs
 */
import { RabbitMQFactory, TranscodingJobData } from '../config/rabbitmq';
import Bull from 'bull';
import { BullQueueManager } from '../services/BullQueueManager';
import { PrismaClient } from '@prisma/client';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { BitrateTranscodingRepository } from '../services/BitrateTranscodingRepository';
import { TranscodingEventPublisher } from '../services/TranscodingEventPublisher';
import { TranscodingArtifactCleanupService } from '../services/TranscodingArtifactCleanupService';
import { runInTransaction } from '../utils/prismaTransaction';
import { updateTranscodingJobStatus } from '../utils/transcodingJobStatus';

export class TranscodingWorker {
   private prisma: PrismaClient;
   private bullQueueManager: BullQueueManager;
   private isRunning = false;
   private readonly bitrateRepo: BitrateTranscodingRepository;
   private readonly eventPublisher: TranscodingEventPublisher;

   constructor(prisma: PrismaClient) {
      this.prisma = prisma;
      this.bullQueueManager = BullQueueManager.getInstance(prisma);
      this.bitrateRepo = new BitrateTranscodingRepository(prisma);
      this.eventPublisher = TranscodingEventPublisher.getInstance();
   }

   /**
    * Start the transcoding worker
    */
   async start(): Promise<void> {
      if (this.isRunning) {
         logger.info('Transcoding worker is already running');
         return;
      }

      try {
         // Initialize RabbitMQ connection
         await RabbitMQFactory.initialize();

         // Initialize Bull queues
         await this.bullQueueManager.initialize();

         logger.info('Starting transcoding worker...');

         // Start consuming from all priority queues
         await Promise.all([
            this.startConsumer('priority'),
            this.startConsumer('normal'),
            this.startConsumer('low')
         ]);

         this.isRunning = true;
         logger.info('Transcoding worker started successfully');

      } catch (error: any) {
         logger.error({ err: error }, 'Failed to start transcoding worker');
         throw error;
      }
   }

   /**
    * Stop the transcoding worker
    */
   async stop(): Promise<void> {
      if (!this.isRunning) {
         logger.info('Transcoding worker is not running');
         return;
      }

      try {
         await RabbitMQFactory.shutdown();
         await this.bullQueueManager.close();
         this.isRunning = false;
         logger.info('Transcoding worker stopped');
      } catch (error: any) {
         logger.error({ err: error }, 'Error stopping transcoding worker');
      }
   }

   /**
    * Start consumer for specific queue
    */
   private async startConsumer(queueName: string): Promise<void> {
      try {
         const rabbitMQ = RabbitMQFactory.getConnection();

         await rabbitMQ.consumeTranscodingJobs(queueName, async (jobData: TranscodingJobData, message) => {
            await this.processTranscodingJob(jobData, message);
         });

         logger.info({ queueName }, 'Started consuming priority transcoding jobs');
      } catch (error: any) {
         logger.error({ err: error, queueName }, 'Error starting consumer for queue');
      }
   }

   /**
    * Process transcoding job
    */
   private async processTranscodingJob(jobData: TranscodingJobData, _message: any): Promise<void> {
      const {
         chapter,
         bitrates,
         priority,
         userId,
         retryCount = 0,
         forceRetranscode = false,
      } = jobData;

      const { id, filePath } = chapter;

      logger.info({ chapterId: id, bitrates: bitrates.join(','), priority, forceRetranscode }, 'Processing transcoding job for chapter');

      try {
         if (!chapter.id) {
            throw new Error(`Chapter ${chapter.id} not found`);
         }

         let targetBitrates = bitrates;

         if (forceRetranscode) {
            await this.bullQueueManager.removeJobsForChapter(chapter.id);
            await this.bitrateRepo.resetAllForRetranscode(chapter.id, bitrates);
            this.eventPublisher.clearThrottle(chapter.id);
            for (const bitrate of bitrates) {
               await this.eventPublisher.publishStatusTransition(chapter.id, bitrate, 'pending', 0);
            }
            TranscodingArtifactCleanupService.scheduleChapterArtifactCleanup(chapter.id);
         } else {
            const existingTranscoded = await this.prisma.transcodedChapter.findMany({
               where: {
                  chapterId: chapter.id,
                  bitrate: { in: bitrates },
                  status: 'completed',
                  storageCommitted: true,
               },
               select: { bitrate: true },
            });

            const existingBitrates = existingTranscoded.map(tc => tc.bitrate);
            targetBitrates = bitrates.filter(bitrate => !existingBitrates.includes(bitrate));

            if (targetBitrates.length === 0) {
               logger.info({ chapterId: chapter.id }, 'Chapter already transcoded for all requested bitrates');
               return;
            }
         }

         await runInTransaction(this.prisma, async tx => {
            const existingJob = await tx.transcodingJob.findFirst({
               where: { chapterId: chapter.id },
               orderBy: { createdAt: 'desc' },
            });
            if (!existingJob || forceRetranscode) {
               await tx.transcodingJob.create({
                  data: {
                     chapterId: chapter.id,
                     status: 'processing',
                     progress: 0,
                     startedAt: new Date(),
                  },
               });
            } else {
               await tx.transcodingJob.update({
                  where: { id: existingJob.id },
                  data: { status: 'processing', progress: 0, startedAt: new Date(), completedAt: null },
               });
            }
         });

         await this.bitrateRepo.upsertPending(chapter.id, targetBitrates);
         for (const bitrate of targetBitrates) {
            await this.eventPublisher.publishStatusTransition(chapter.id, bitrate, 'pending', 0);
         }

         const outputDir = `bit_transcode/${chapter.id}`;

         const bitrateJobs: Bull.Job[] = [];
         for (const bitrate of targetBitrates) {
            try {
               const job = await this.bullQueueManager.addBitrateTranscodingJob({
                  chapterId: chapter.id,
                  inputPath: filePath,
                  outputDir,
                  bitrate,
                  segmentDuration: config.HLS_SEGMENT_DURATION,
                  ...(userId && { userId })
               }, priority);

               bitrateJobs.push(job);
               logger.info({ chapterId: chapter.id, bitrate, jobId: job.id }, 'Created Bull job for bitrate');
            } catch (error: any) {
               logger.error({ err: error, chapterId: chapter.id, bitrate }, 'Failed to create Bull job for bitrate');
               // Continue with other bitrates
            }
         }

         // Create master playlist job if we have any bitrate jobs
         if (bitrateJobs.length > 0) {
            try {
               const masterJob = await this.bullQueueManager.addMasterPlaylistJob({
                  chapterId: chapter.id,
                  audiobookId: chapter.audiobookId,
                  outputDir,
                  variantBitrates: targetBitrates,
               }, priority);

               logger.info({ chapterId: chapter.id, jobId: masterJob.id }, 'Created master playlist Bull job');
            } catch (error: any) {
               logger.error({ err: error, chapterId: chapter.id }, 'Failed to create master playlist Bull job');
            }
         }

         logger.info({ chapterId: chapter.id, bitrateJobCount: bitrateJobs.length }, 'Successfully dispatched bitrate jobs and master job for chapter');

      } catch (error: any) {
         logger.error({ err: error, chapterId: chapter.id }, 'Transcoding job failed for chapter');

         // Handle retry logic
         if (retryCount < 3) {
            logger.info({ chapterId: chapter.id, attempt: retryCount + 1 }, 'Retrying transcoding job for chapter');

            // Publish job back to queue with increased retry count
            const retryJobData: TranscodingJobData = {
               ...jobData,
               retryCount: retryCount + 1,
               priority: 'low' // Lower priority for retries
            };

            await this.publishTranscodingJob(retryJobData, 'low');
         } else {
            logger.error({ chapterId: chapter.id }, 'Max retries reached for chapter, marking as failed');
         }

         // Update job status in database
         await updateTranscodingJobStatus(this.prisma, {
            chapterId: chapter.id,
            status: 'failed',
            progress: 0,
            errorMessage: error.message,
         });
      }
   }

   /**
    * Publish transcoding job
    */
   private async publishTranscodingJob(jobData: TranscodingJobData, priority: 'normal' | 'low' | 'high'): Promise<void> {
      try {
         const rabbitMQ = RabbitMQFactory.getConnection();
         await rabbitMQ.publishTranscodingJob(jobData, priority);
      } catch (error: any) {
         logger.error({ err: error }, 'Error publishing transcoding job');
      }
   }

   /**
    * Get worker statistics
    */
   async getWorkerStats(): Promise<{
      isRunning: boolean;
      queueStats: any;
      recentJobs: any[];
   }> {
      try {
         const rabbitMQ = RabbitMQFactory.getConnection();
         const queueStats = await rabbitMQ.getQueueStats();

         const recentJobs = await this.prisma.transcodingJob.findMany({
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
               id: true,
               chapterId: true,
               status: true,
               progress: true,
               createdAt: true,
               completedAt: true
            }
         });

         return {
            isRunning: this.isRunning,
            queueStats,
            recentJobs
         };
      } catch (error: any) {
         logger.error({ err: error }, 'Error getting worker stats');
         return {
            isRunning: this.isRunning,
            queueStats: {},
            recentJobs: []
         };
      }
   }

   /**
    * Test worker functionality
    */
   async testWorker(): Promise<boolean> {
      try {
         // Test RabbitMQ connection
         const rabbitMQ = RabbitMQFactory.getConnection();
         const isConnected = rabbitMQ.isConnected();

         // Test Bull queue manager
         const bullReady = this.bullQueueManager.isReady();

         // Test database connection
         await this.prisma.$queryRaw`SELECT 1`;

         logger.info({
            rabbitMQConnected: isConnected,
            bullQueuesReady: bullReady,
            databaseConnected: true
         }, 'Worker test results');

         return isConnected && bullReady;
      } catch (error: any) {
         logger.error({ err: error }, 'Worker test failed');
         return false;
      }
   }
}

/**
 * Worker factory for easy access
 */
export class TranscodingWorkerFactory {
   private static worker: TranscodingWorker | null = null;

   /**
    * Get worker instance
    */
   public static getWorker(prisma: PrismaClient): TranscodingWorker {
      if (!TranscodingWorkerFactory.worker) {
         TranscodingWorkerFactory.worker = new TranscodingWorker(prisma);
      }
      return TranscodingWorkerFactory.worker;
   }

   /**
    * Start worker
    */
   public static async startWorker(prisma: PrismaClient): Promise<void> {
      const worker = TranscodingWorkerFactory.getWorker(prisma);
      await worker.start();
   }

   /**
    * Stop worker
    */
   public static async stopWorker(): Promise<void> {
      if (TranscodingWorkerFactory.worker) {
         await TranscodingWorkerFactory.worker.stop();
         TranscodingWorkerFactory.worker = null;
      }
   }
}
