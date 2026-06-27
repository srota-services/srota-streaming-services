/**
 * Bitrate Transcoding Repository
 * DB helpers with transaction support for per-bitrate transcoding state
 */
import { PrismaClient } from '@prisma/client';
import { config } from '../config/env';
import { toStorageKey } from '../utils/storageKeys';
import { runInTransaction, runWrite } from '../utils/prismaTransaction';
import { rethrowServiceError } from '../utils/serviceError';
import { assertNonEmptyChapterId, assertNumericBitrate } from '../utils/streamingValidation';
import { BitrateTranscodingState } from '../types/transcoding';

export interface UpsertBitrateParams {
   chapterId: string;
   bitrate: number;
   status: BitrateTranscodingState;
   progress?: number;
   playlistUrl?: string;
   segmentsPath?: string;
   storageProvider?: string;
   storageCommitted?: boolean;
   errorMessage?: string | null;
}

export class BitrateTranscodingRepository {
   constructor(private readonly prisma: PrismaClient) {}

   async upsertPending(chapterId: string, bitrates: number[]): Promise<void> {
      assertNonEmptyChapterId(chapterId);

      try {
         await runInTransaction(this.prisma, async tx => {
            for (const bitrate of bitrates) {
               assertNumericBitrate(bitrate);
               await tx.transcodedChapter.upsert({
                  where: { chapterId_bitrate: { chapterId, bitrate } },
                  update: {
                     status: 'pending',
                     progress: 0,
                     errorMessage: null,
                     storageCommitted: false,
                     updatedAt: new Date(),
                  },
                  create: {
                     chapterId,
                     bitrate,
                     status: 'pending',
                     progress: 0,
                     playlistUrl: '',
                     segmentsPath: '',
                     storageProvider: 'local',
                     storageCommitted: false,
                  },
               });
            }
         });
      } catch (error: unknown) {
         rethrowServiceError(error, { operation: 'upsertPending', chapterId });
      }
   }

   async updateProgress(
      chapterId: string,
      bitrate: number,
      progress: number
   ): Promise<void> {
      assertNonEmptyChapterId(chapterId);
      assertNumericBitrate(bitrate);

      try {
         await runWrite(this.prisma, async tx => {
            await tx.transcodedChapter.update({
               where: { chapterId_bitrate: { chapterId, bitrate } },
               data: { progress, updatedAt: new Date() },
            });
         });
      } catch (error: unknown) {
         rethrowServiceError(error, { operation: 'updateProgress', chapterId, bitrate });
      }
   }

   async markProcessing(chapterId: string, bitrate: number): Promise<void> {
      assertNonEmptyChapterId(chapterId);
      assertNumericBitrate(bitrate);

      try {
         await runWrite(this.prisma, async tx => {
            await tx.transcodedChapter.upsert({
               where: { chapterId_bitrate: { chapterId, bitrate } },
               update: {
                  status: 'processing',
                  progress: 0,
                  errorMessage: null,
                  updatedAt: new Date(),
               },
               create: {
                  chapterId,
                  bitrate,
                  status: 'processing',
                  progress: 0,
                  playlistUrl: '',
                  segmentsPath: '',
                  storageProvider: 'local',
                  storageCommitted: false,
               },
            });
         });
      } catch (error: unknown) {
         rethrowServiceError(error, { operation: 'markProcessing', chapterId, bitrate });
      }
   }

   async commitCompletedLocal(
      chapterId: string,
      bitrate: number
   ): Promise<{ playlistUrl: string; segmentsPath: string }> {
      assertNonEmptyChapterId(chapterId);
      assertNumericBitrate(bitrate);

      const playlistUrl = toStorageKey(`bit_transcode/${chapterId}/${bitrate}k/playlist.m3u8`);
      const segmentsPath = toStorageKey(`bit_transcode/${chapterId}/${bitrate}k/`);

      try {
         await runWrite(this.prisma, async tx => {
            await tx.transcodedChapter.upsert({
               where: { chapterId_bitrate: { chapterId, bitrate } },
               update: {
                  playlistUrl,
                  segmentsPath,
                  status: 'completed',
                  progress: 100,
                  storageProvider: 'local',
                  storageCommitted: true,
                  errorMessage: null,
                  updatedAt: new Date(),
               },
               create: {
                  chapterId,
                  bitrate,
                  playlistUrl,
                  segmentsPath,
                  status: 'completed',
                  progress: 100,
                  storageProvider: 'local',
                  storageCommitted: true,
               },
            });
         });
      } catch (error: unknown) {
         rethrowServiceError(error, { operation: 'commitCompletedLocal', chapterId, bitrate });
      }

      return { playlistUrl, segmentsPath };
   }

   async markStoredOnS3(chapterId: string, bitrate: number): Promise<void> {
      assertNonEmptyChapterId(chapterId);
      assertNumericBitrate(bitrate);

      try {
         await runWrite(this.prisma, async tx => {
            await tx.transcodedChapter.update({
               where: { chapterId_bitrate: { chapterId, bitrate } },
               data: {
                  storageProvider: config.STORAGE_PROVIDER,
                  progress: 100,
                  updatedAt: new Date(),
               },
            });
         });
      } catch (error: unknown) {
         rethrowServiceError(error, { operation: 'markStoredOnS3', chapterId, bitrate });
      }
   }

   async markFailed(
      chapterId: string,
      bitrate: number,
      progress: number,
      errorMessage: string
   ): Promise<void> {
      assertNonEmptyChapterId(chapterId);
      assertNumericBitrate(bitrate);

      try {
         await runWrite(this.prisma, async tx => {
            await tx.transcodedChapter.upsert({
               where: { chapterId_bitrate: { chapterId, bitrate } },
               update: {
                  status: 'failed',
                  progress,
                  errorMessage,
                  updatedAt: new Date(),
               },
               create: {
                  chapterId,
                  bitrate,
                  status: 'failed',
                  progress,
                  errorMessage,
                  playlistUrl: '',
                  segmentsPath: '',
                  storageProvider: 'local',
                  storageCommitted: false,
               },
            });
         });
      } catch (error: unknown) {
         rethrowServiceError(error, { operation: 'markFailed', chapterId, bitrate });
      }
   }

   async resetForRetry(chapterId: string, bitrates: number[]): Promise<void> {
      assertNonEmptyChapterId(chapterId);

      try {
         await runInTransaction(this.prisma, async tx => {
            for (const bitrate of bitrates) {
               assertNumericBitrate(bitrate);
               await tx.transcodedChapter.upsert({
                  where: { chapterId_bitrate: { chapterId, bitrate } },
                  update: {
                     status: 'pending',
                     progress: 0,
                     errorMessage: null,
                     storageCommitted: false,
                     updatedAt: new Date(),
                  },
                  create: {
                     chapterId,
                     bitrate,
                     status: 'pending',
                     progress: 0,
                     playlistUrl: '',
                     segmentsPath: '',
                     storageProvider: 'local',
                     storageCommitted: false,
                  },
               });
            }
         });
      } catch (error: unknown) {
         rethrowServiceError(error, { operation: 'resetForRetry', chapterId });
      }
   }

   async resetAllForRetranscode(chapterId: string, bitrates: number[]): Promise<void> {
      assertNonEmptyChapterId(chapterId);

      try {
         await runInTransaction(this.prisma, async tx => {
            await tx.transcodedChapter.deleteMany({ where: { chapterId } });
            for (const bitrate of bitrates) {
               assertNumericBitrate(bitrate);
               await tx.transcodedChapter.create({
                  data: {
                     chapterId,
                     bitrate,
                     status: 'pending',
                     progress: 0,
                     playlistUrl: '',
                     segmentsPath: '',
                     storageProvider: 'local',
                     storageCommitted: false,
                  },
               });
            }
            const existingJob = await tx.transcodingJob.findFirst({
               where: { chapterId },
               orderBy: { createdAt: 'desc' },
            });
            if (existingJob) {
               await tx.transcodingJob.update({
                  where: { id: existingJob.id },
                  data: {
                     status: 'processing',
                     progress: 0,
                     errorMessage: null,
                     startedAt: new Date(),
                     completedAt: null,
                     updatedAt: new Date(),
                  },
               });
            } else {
               await tx.transcodingJob.create({
                  data: {
                     chapterId,
                     status: 'processing',
                     progress: 0,
                     startedAt: new Date(),
                  },
               });
            }
         });
      } catch (error: unknown) {
         rethrowServiceError(error, { operation: 'resetAllForRetranscode', chapterId });
      }
   }

   async getBitrateRows(chapterId: string) {
      return this.prisma.transcodedChapter.findMany({
         where: { chapterId },
         orderBy: { bitrate: 'asc' },
      });
   }

   async allBitratesCompleted(chapterId: string, expectedBitrates: number[]): Promise<boolean> {
      const rows = await this.prisma.transcodedChapter.findMany({
         where: { chapterId, status: 'completed' },
         select: { bitrate: true },
      });
      const completed = new Set(rows.map(r => r.bitrate));
      return expectedBitrates.every(b => completed.has(b));
   }
}
