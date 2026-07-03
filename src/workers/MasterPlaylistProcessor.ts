/**
 * Master Playlist Processor
 * Processes master playlist generation jobs using Bull
 */
import Bull from 'bull';
import { PrismaClient } from '@prisma/client';
import { TranscodingService } from '../services/TranscodingService';
import { MasterPlaylistJobData } from '../config/bull';
import { toStorageKey } from '../utils/storageKeys';
import { bullLogger, logger } from '../config/logger';
import { updateTranscodingJobStatus } from '../utils/transcodingJobStatus';
import { RabbitMQFactory } from '../config/rabbitmq';

export class MasterPlaylistProcessor {
   private prisma: PrismaClient;
   private transcodingService: TranscodingService;

   constructor(prisma: PrismaClient) {
      this.prisma = prisma;
      this.transcodingService = new TranscodingService(prisma);
   }

   /**
    * Process master playlist generation job
    */
   public async processMasterPlaylist(job: Bull.Job<MasterPlaylistJobData>): Promise<void> {
      const { chapterId, audiobookId, variantBitrates } = job.data;

      bullLogger.info({ chapterId }, 'Processing master playlist generation for chapter');

      try {
         await job.progress(10);

         const completedBitrates = await this.waitForBitrateJobs(chapterId, variantBitrates);

         if (completedBitrates.length !== variantBitrates.length) {
            throw new Error(
               `Not all bitrates completed successfully (expected ${variantBitrates.length}, got ${completedBitrates.length})`,
            );
         }

         await job.progress(30);

         const masterPlaylist = await this.generateMasterPlaylistForBitrates(chapterId, completedBitrates);

         await job.progress(70);

         await this.uploadMasterPlaylist(chapterId, masterPlaylist);

         await updateTranscodingJobStatus(this.prisma, {
            chapterId,
            status: 'completed',
            progress: 100,
         });

         await this.publishTranscodingCompleted(chapterId, audiobookId, completedBitrates);

         await job.progress(100);

         bullLogger.info({ chapterId }, 'Successfully completed master playlist generation for chapter');

      } catch (error: any) {
         bullLogger.error({ err: error, chapterId }, 'Master playlist generation failed for chapter');

         await updateTranscodingJobStatus(this.prisma, {
            chapterId,
            status: 'failed',
            progress: 0,
            errorMessage: error.message,
         });

         throw error;
      }
   }

   private async publishTranscodingCompleted(
      chapterId: string,
      audiobookId: string | undefined,
      bitrates: number[],
   ): Promise<void> {
      if (!audiobookId) {
         bullLogger.warn({ chapterId }, 'Skipping chapter transcoding completed publish — audiobookId missing');
         return;
      }

      try {
         const rabbitMQ = RabbitMQFactory.getConnection();
         await rabbitMQ.publishChapterTranscodingCompleted({
            chapterId,
            audiobookId,
            bitrates,
            status: 'completed',
            timestamp: new Date().toISOString(),
         });
      } catch (error: any) {
         bullLogger.error({ err: error, chapterId }, 'Failed to publish chapter transcoding completed event');
      }
   }

   /**
    * Wait for all bitrate jobs to complete; fail on timeout or partial success.
    */
   private async waitForBitrateJobs(chapterId: string, expectedBitrates: number[]): Promise<number[]> {
      const maxWaitTime = 30 * 60 * 1000; // 30 minutes
      const checkInterval = 5000; // 5 seconds
      const startTime = Date.now();

      logger.info({ chapterId, expectedBitrates: expectedBitrates.join(', ') }, 'Waiting for bitrate jobs to complete for chapter');

      while (Date.now() - startTime < maxWaitTime) {
         const completedBitrates = await this.getCompletedBitrates(chapterId, expectedBitrates);

         if (completedBitrates.length === expectedBitrates.length) {
            logger.info({ chapterId, count: completedBitrates.length, completedBitrates: completedBitrates.join(', ') }, 'All expected bitrates completed for chapter');
            return completedBitrates;
         }

         if (await this.haveAllBitratesFailed(chapterId, expectedBitrates)) {
            throw new Error('All bitrate transcoding jobs failed; retry transcoding after fixing the source file');
         }

         if (completedBitrates.length > 0) {
            logger.info({ chapterId, completed: completedBitrates.length, expected: expectedBitrates.length, completedBitrates: completedBitrates.join(', ') }, 'Found partial completed bitrates for chapter, waiting for more');
         }

         await new Promise(resolve => setTimeout(resolve, checkInterval));
      }

      const finalBitrates = await this.getCompletedBitrates(chapterId, expectedBitrates);

      if (finalBitrates.length === expectedBitrates.length) {
         return finalBitrates;
      }

      throw new Error(
         `Timeout waiting for all bitrate jobs (expected ${expectedBitrates.length}, completed ${finalBitrates.length})`,
      );
   }

   private async getCompletedBitrates(chapterId: string, expectedBitrates: number[]): Promise<number[]> {
      const completedTranscoded = await this.prisma.transcodedChapter.findMany({
         where: {
            chapterId,
            bitrate: { in: expectedBitrates },
            status: 'completed',
         },
         select: { bitrate: true },
      });

      return completedTranscoded.map(tc => tc.bitrate);
   }

   private async haveAllBitratesFailed(chapterId: string, expectedBitrates: number[]): Promise<boolean> {
      const rows = await this.prisma.transcodedChapter.findMany({
         where: {
            chapterId,
            bitrate: { in: expectedBitrates },
         },
         select: { bitrate: true, status: true },
      });

      return expectedBitrates.every(
         bitrate => rows.find(row => row.bitrate === bitrate)?.status === 'failed',
      );
   }

   /**
    * Generate master playlist for specific bitrates
    */
   private async generateMasterPlaylistForBitrates(chapterId: string, _bitrates: number[]): Promise<string> {
      try {
         const transcodedChapters = await this.prisma.transcodedChapter.findMany({
            where: {
               chapterId,
               status: 'completed',
            },
            orderBy: {
               bitrate: 'asc',
            },
         });

         if (transcodedChapters.length === 0) {
            throw new Error('No completed transcoded chapters found');
         }

         logger.info({ chapterId, count: transcodedChapters.length, bitrates: transcodedChapters.map(tc => tc.bitrate).join(', ') }, 'Generating master playlist for chapter');

         const variantPlaylists = transcodedChapters.map(tc => ({
            bitrate: tc.bitrate,
            playlist: '',
            segments: [],
         }));

         const masterPlaylist = this.transcodingService.generateMasterPlaylist(variantPlaylists, chapterId);

         return masterPlaylist;
      } catch (error: any) {
         logger.error({ err: error }, 'Error generating master playlist');
         throw error;
      }
   }

   /**
    * Upload master playlist to storage
    */
   private async uploadMasterPlaylist(chapterId: string, masterPlaylist: string): Promise<void> {
      try {
         await this.transcodingService['initializeStorageProvider']();

         const masterPlaylistPath = toStorageKey(`bit_transcode/${chapterId}/master.m3u8`);
         await this.transcodingService['storageProvider']!.uploadFile(
            masterPlaylistPath,
            Buffer.from(masterPlaylist),
            'application/vnd.apple.mpegurl',
         );

         logger.info({ chapterId }, 'Master playlist uploaded for chapter');
      } catch (error: any) {
         logger.error({ err: error }, 'Error uploading master playlist');
         throw error;
      }
   }
}
