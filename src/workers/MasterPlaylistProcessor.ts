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
      const { chapterId, variantBitrates } = job.data;

      bullLogger.info({ chapterId }, 'Processing master playlist generation for chapter');

      try {
         // Update job progress
         await job.progress(10);

         // Wait for bitrate jobs to complete and check which ones succeeded
         const completedBitrates = await this.waitForBitrateJobs(chapterId, variantBitrates);

         if (completedBitrates.length === 0) {
            throw new Error('No bitrate transcoding jobs completed successfully');
         }

         // Update job progress
         await job.progress(30);

         // Generate HLS master playlist for completed bitrates
         const masterPlaylist = await this.generateMasterPlaylistForBitrates(chapterId, completedBitrates);

         // Update job progress
         await job.progress(70);

         // Upload HLS master playlist to storage
         await this.uploadMasterPlaylist(chapterId, masterPlaylist);

         await updateTranscodingJobStatus(this.prisma, {
            chapterId,
            status: 'completed',
            progress: 100,
         });

         // Update job progress
         await job.progress(100);

         bullLogger.info({ chapterId }, 'Successfully completed master playlist generation for chapter');

      } catch (error: any) {
         bullLogger.error({ err: error, chapterId }, 'Master playlist generation failed for chapter');

         // Update database with error
         await updateTranscodingJobStatus(this.prisma, {
            chapterId,
            status: 'failed',
            progress: 0,
            errorMessage: error.message,
         });

         throw error; // Re-throw to mark job as failed
      }
   }

   /**
    * Wait for bitrate jobs to complete and return successful ones
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

      if (finalBitrates.length > 0) {
         logger.warn({ chapterId, count: finalBitrates.length, completedBitrates: finalBitrates.join(', ') }, 'Timeout waiting for all bitrate jobs for chapter, returning completed bitrates');
         return finalBitrates;
      }

      logger.warn({ chapterId }, 'Timeout waiting for bitrate jobs for chapter, no bitrates completed');
      return [];
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
         bitrate => rows.find(row => row.bitrate === bitrate)?.status === 'failed'
      );
   }

   /**
    * Generate master playlist for specific bitrates
    */
   private async generateMasterPlaylistForBitrates(chapterId: string, _bitrates: number[]): Promise<string> {
      try {
         // Get ALL completed transcoded chapters for this chapter (not just the ones passed in)
         // This ensures we include any bitrates that completed after the initial check
         const transcodedChapters = await this.prisma.transcodedChapter.findMany({
            where: {
               chapterId,
               status: 'completed'
            },
            orderBy: {
               bitrate: 'asc'
            }
         });

         if (transcodedChapters.length === 0) {
            throw new Error('No completed transcoded chapters found');
         }

         logger.info({ chapterId, count: transcodedChapters.length, bitrates: transcodedChapters.map(tc => tc.bitrate).join(', ') }, 'Generating master playlist for chapter');

         // Create variant playlists data structure
         const variantPlaylists = transcodedChapters.map(tc => ({
            bitrate: tc.bitrate,
            playlist: '', // We don't need the actual playlist content for master generation
            segments: [] // We don't need segments for master generation
         }));

         // Generate master playlist using TranscodingService
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
         // Initialize storage provider
         await this.transcodingService['initializeStorageProvider']();

         // Upload master playlist to bit_transcode/{chapter_id} directory
         const masterPlaylistPath = toStorageKey(`bit_transcode/${chapterId}/master.m3u8`);
         await this.transcodingService['storageProvider']!.uploadFile(
            masterPlaylistPath,
            Buffer.from(masterPlaylist),
            'application/vnd.apple.mpegurl'
         );

         logger.info({ chapterId }, 'Master playlist uploaded for chapter');
      } catch (error: any) {
         logger.error({ err: error }, 'Error uploading master playlist');
         throw error;
      }
   }
}
