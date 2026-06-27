/**
 * Bull Queue Manager
 * Manages all Bull queues for transcoding jobs
 */
import Bull from 'bull';
import { PrismaClient } from '@prisma/client';
import {
   QUEUE_NAMES,
   createQueue,
   getAllQueueNames,
   getBitrateQueueNames,
   getQueueNameForBitrate,
   BitrateTranscodingJobData,
   MasterPlaylistJobData,
   DEFAULT_JOB_OPTIONS
} from '../config/bull';
import { bullLogger } from '../config/logger';
import { chapterSourceFileExists } from '../utils/chapterSourceFile';
import { runWrite } from '../utils/prismaTransaction';
import { rethrowServiceError } from '../utils/serviceError';
import { updateTranscodingJobStatus } from '../utils/transcodingJobStatus';

export class BullQueueManager {
   private static instance: BullQueueManager;
   private queues: Map<string, Bull.Queue> = new Map();
   private prisma: PrismaClient;
   private isInitialized = false;

   private constructor(prisma: PrismaClient) {
      this.prisma = prisma;
   }

   public static getInstance(prisma: PrismaClient): BullQueueManager {
      if (!BullQueueManager.instance) {
         BullQueueManager.instance = new BullQueueManager(prisma);
      }
      return BullQueueManager.instance;
   }

   public async initialize(): Promise<void> {
      if (this.isInitialized) {
         return;
      }

      try {
         bullLogger.info('Initializing Bull queues...');

         for (const queueName of getAllQueueNames()) {
            const queue = createQueue(queueName);
            this.queues.set(queueName, queue);
            this.setupQueueEventListeners(queue, queueName);
            bullLogger.info({ queueName }, 'Queue created successfully');
         }

         await this.reconcileStaleJobs();

         this.isInitialized = true;
         bullLogger.info('All Bull queues initialized successfully');
      } catch (error: any) {
         bullLogger.error({ err: error }, 'Error initializing Bull queues');
         throw error;
      }
   }

   private setupQueueEventListeners(queue: Bull.Queue, queueName: string): void {
      queue.on('ready', () => {
         bullLogger.info({ queueName }, 'Queue is ready');
      });

      queue.on('error', (error) => {
         bullLogger.error({ err: error, queueName }, 'Queue error');
      });

      queue.on('waiting', (jobId) => {
         bullLogger.debug({ jobId, queueName }, 'Job is waiting in queue');
      });

      queue.on('active', (job) => {
         bullLogger.info({ jobId: job.id, queueName }, 'Job is active in queue');
      });

      queue.on('stalled', (job) => {
         bullLogger.warn({ jobId: job.id, queueName }, 'Job is stalled in queue');
      });

      queue.on('progress', async (job, progress) => {
         bullLogger.debug({ jobId: job.id, progress, queueName }, 'Job progress');
         // Per-bitrate progress is tracked in transcoded_chapters via TranscodingService
      });

      queue.on('completed', async (job) => {
         bullLogger.info({ jobId: job.id, queueName }, 'Job completed in queue');
         // Chapter-level completion is handled by MasterPlaylistProcessor
      });

      queue.on('failed', async (job, err) => {
         bullLogger.error({ err, jobId: job.id, queueName }, 'Job failed in queue');
         if (queueName === QUEUE_NAMES.MASTER_PLAYLIST) {
            await updateTranscodingJobStatus(this.prisma, {
               chapterId: job.data.chapterId,
               status: 'failed',
               progress: 0,
               errorMessage: err.message,
               createIfMissing: false,
            });
         }
      });

      queue.on('paused', () => {
         bullLogger.info({ queueName }, 'Queue is paused');
      });

      queue.on('resumed', () => {
         bullLogger.info({ queueName }, 'Queue is resumed');
      });

      queue.on('cleaned', (jobs, type) => {
         bullLogger.info({ count: jobs.length, type, queueName }, 'Cleaned jobs from queue');
      });

      queue.on('drained', () => {
         bullLogger.info({ queueName }, 'Queue is drained');
      });
   }

   public async addBitrateTranscodingJob(
      data: BitrateTranscodingJobData,
      priority: 'low' | 'normal' | 'high' = 'normal'
   ): Promise<Bull.Job> {
      const queueName = getQueueNameForBitrate(data.bitrate);
      const queue = this.queues.get(queueName);

      if (!queue) {
         throw new Error(`Queue ${queueName} not found`);
      }

      const jobOptions: Bull.JobOptions = {
         ...DEFAULT_JOB_OPTIONS,
         priority: priority === 'high' ? 10 : priority === 'normal' ? 5 : 1,
         jobId: `${data.chapterId}-${data.bitrate}k-${Date.now()}`
      };

      const job = await queue.add(data, jobOptions);
      bullLogger.info({ chapterId: data.chapterId, bitrate: data.bitrate, queueName }, 'Added bitrate transcoding job');

      return job;
   }

   public async addMasterPlaylistJob(
      data: MasterPlaylistJobData,
      priority: 'low' | 'normal' | 'high' = 'normal'
   ): Promise<Bull.Job> {
      const queue = this.queues.get(QUEUE_NAMES.MASTER_PLAYLIST);

      if (!queue) {
         throw new Error(`Queue ${QUEUE_NAMES.MASTER_PLAYLIST} not found`);
      }

      const jobOptions: Bull.JobOptions = {
         ...DEFAULT_JOB_OPTIONS,
         priority: priority === 'high' ? 10 : priority === 'normal' ? 5 : 1,
         jobId: `${data.chapterId}-master-${Date.now()}`,
         delay: 5000
      };

      const job = await queue.add(data, jobOptions);
      bullLogger.info({ chapterId: data.chapterId, queueName: QUEUE_NAMES.MASTER_PLAYLIST }, 'Added master playlist job');

      return job;
   }

   public getQueue(queueName: string): Bull.Queue | undefined {
      return this.queues.get(queueName);
   }

   public getAllQueues(): Map<string, Bull.Queue> {
      return this.queues;
   }

   public async getQueueStats(): Promise<{
      [queueName: string]: {
         waiting: number;
         active: number;
         completed: number;
         failed: number;
         delayed: number;
      };
   }> {
      const stats: Record<string, {
         waiting: number;
         active: number;
         completed: number;
         failed: number;
         delayed: number;
      }> = {};

      for (const [queueName, queue] of this.queues) {
         const counts = await queue.getJobCounts();
         stats[queueName] = {
            waiting: counts.waiting,
            active: counts.active,
            completed: counts.completed,
            failed: counts.failed,
            delayed: counts.delayed
         };
      }

      return stats;
   }

   public async getJob(queueName: string, jobId: string): Promise<Bull.Job | null> {
      const queue = this.queues.get(queueName);
      if (!queue) {
         return null;
      }
      return await queue.getJob(jobId);
   }

   public async removeJobsForChapter(chapterId: string): Promise<void> {
      for (const [queueName, queue] of this.queues) {
         const jobs = await queue.getJobs(['active', 'waiting', 'delayed', 'failed']);
         for (const job of jobs) {
            if (job.data?.chapterId === chapterId) {
               try {
                  await job.remove();
                  bullLogger.info({ jobId: job.id, queueName, chapterId }, 'Removed Bull job for chapter');
               } catch (error: unknown) {
                  bullLogger.warn({ err: error, jobId: job.id, chapterId }, 'Failed to remove Bull job');
               }
            }
         }
      }
   }

   /**
    * Remove orphaned master jobs and retry failed bitrate jobs when source audio is available.
    */
   private async reconcileStaleJobs(): Promise<void> {
      try {
         await this.removeOrphanedMasterJobs();
         await this.retryFailedBitrateJobsWithAvailableSource();
      } catch (error: unknown) {
         bullLogger.warn({ err: error }, 'Failed to reconcile stale Bull jobs on startup');
      }
   }

   private async removeOrphanedMasterJobs(): Promise<void> {
      const masterQueue = this.queues.get(QUEUE_NAMES.MASTER_PLAYLIST);
      if (!masterQueue) {
         return;
      }

      const jobs = await masterQueue.getJobs(['waiting', 'delayed', 'active']);
      for (const job of jobs) {
         const { chapterId, variantBitrates } = job.data as MasterPlaylistJobData;
         if (!chapterId || !variantBitrates?.length) {
            continue;
         }

         if (await this.hasActiveBitrateJobsForChapter(chapterId)) {
            continue;
         }

         const rows = await this.prisma.transcodedChapter.findMany({
            where: { chapterId, bitrate: { in: variantBitrates } },
            select: { bitrate: true, status: true },
         });

         const allFailed = variantBitrates.every(
            bitrate => rows.find(row => row.bitrate === bitrate)?.status === 'failed'
         );
         const allCompleted = variantBitrates.every(
            bitrate => rows.find(row => row.bitrate === bitrate)?.status === 'completed'
         );

         if (allFailed || allCompleted) {
            await job.remove();
            bullLogger.info(
               { jobId: job.id, chapterId, allFailed, allCompleted },
               'Removed orphaned master playlist job'
            );
         }
      }
   }

   private async hasActiveBitrateJobsForChapter(chapterId: string): Promise<boolean> {
      for (const queueName of getBitrateQueueNames()) {
         const queue = this.queues.get(queueName);
         if (!queue) {
            continue;
         }

         const jobs = await queue.getJobs(['active', 'waiting', 'delayed']);
         if (jobs.some(job => job.data?.chapterId === chapterId)) {
            return true;
         }
      }

      return false;
   }

   private async retryFailedBitrateJobsWithAvailableSource(): Promise<void> {
      const chaptersNeedingMaster = new Map<string, { outputDir: string; bitrates: number[] }>();

      for (const queueName of getBitrateQueueNames()) {
         const queue = this.queues.get(queueName);
         if (!queue) {
            continue;
         }

         const failedJobs = await queue.getJobs(['failed']);
         for (const job of failedJobs) {
            const data = job.data as BitrateTranscodingJobData | undefined;
            if (!data?.chapterId || !data.inputPath || !data.bitrate) {
               continue;
            }

            if (!(await chapterSourceFileExists(data.inputPath))) {
               continue;
            }

            try {
               await runWrite(this.prisma, async tx => {
                  await tx.transcodedChapter.updateMany({
                     where: {
                        chapterId: data.chapterId,
                        bitrate: data.bitrate,
                        status: 'failed',
                     },
                     data: {
                        status: 'pending',
                        progress: 0,
                        errorMessage: null,
                     },
                  });
               });
            } catch (error: unknown) {
               rethrowServiceError(error, {
                  operation: 'retryFailedBitrateJobsWithAvailableSource',
                  chapterId: data.chapterId,
                  bitrate: data.bitrate,
               });
            }

            await job.retry();
            bullLogger.info(
               { jobId: job.id, chapterId: data.chapterId, bitrate: data.bitrate, queueName },
               'Retrying failed bitrate job after source file became available'
            );

            const existing = chaptersNeedingMaster.get(data.chapterId);
            if (existing) {
               if (!existing.bitrates.includes(data.bitrate)) {
                  existing.bitrates.push(data.bitrate);
               }
            } else {
               chaptersNeedingMaster.set(data.chapterId, {
                  outputDir: data.outputDir,
                  bitrates: [data.bitrate],
               });
            }
         }
      }

      for (const [chapterId, { outputDir, bitrates }] of chaptersNeedingMaster) {
         await this.addMasterPlaylistJob(
            {
               chapterId,
               outputDir,
               variantBitrates: bitrates.sort((a, b) => a - b),
            },
            'normal'
         );
      }
   }

   public async retryJob(queueName: string, jobId: string): Promise<void> {
      const queue = this.queues.get(queueName);
      if (!queue) {
         throw new Error(`Queue ${queueName} not found`);
      }

      const job = await queue.getJob(jobId);
      if (!job) {
         throw new Error(`Job ${jobId} not found in queue ${queueName}`);
      }

      await job.retry();
      bullLogger.info({ jobId, queueName }, 'Retried job in queue');
   }

   public async cleanupOldJobs(queueName: string, maxAge: number = 24 * 60 * 60 * 1000): Promise<void> {
      const queue = this.queues.get(queueName);
      if (!queue) {
         return;
      }

      await queue.clean(maxAge, 'completed');
      await queue.clean(maxAge, 'failed');
      bullLogger.info({ queueName }, 'Cleaned up old jobs in queue');
   }

   public async close(): Promise<void> {
      bullLogger.info('Closing Bull queues...');

      const closePromises = Array.from(this.queues.values()).map(queue => queue.close());
      await Promise.all(closePromises);

      this.queues.clear();
      this.isInitialized = false;
      bullLogger.info('All Bull queues closed');
   }

   public isReady(): boolean {
      return this.isInitialized;
   }
}
