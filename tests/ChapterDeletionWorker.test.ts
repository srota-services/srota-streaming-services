jest.mock('../src/config/logger', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

const mockRemoveJobsForChapter = jest.fn().mockResolvedValue(undefined);
const mockClearChapterCache = jest.fn().mockResolvedValue(2);
const mockCleanupChapterArtifacts = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/services/BullQueueManager', () => ({
   BullQueueManager: {
      getInstance: jest.fn(() => ({
         removeJobsForChapter: mockRemoveJobsForChapter,
      })),
   },
}));

jest.mock('../src/services/StreamingCacheService', () => ({
   StreamingCacheFactory: {
      getInstance: jest.fn(() => ({
         clearChapterCache: mockClearChapterCache,
      })),
   },
}));

jest.mock('../src/services/TranscodingArtifactCleanupService', () => ({
   TranscodingArtifactCleanupService: {
      cleanupChapterArtifacts: mockCleanupChapterArtifacts,
   },
}));

import { ChapterDeletionWorker } from '../src/workers/ChapterDeletionWorker';

function createPrismaMock() {
   const transcodingJobDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
   const streamingSessionDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
   const transcodedChapterDeleteMany = jest.fn().mockResolvedValue({ count: 0 });

   const tx = {
      transcodingJob: { deleteMany: transcodingJobDeleteMany },
      streamingSession: { deleteMany: streamingSessionDeleteMany },
      transcodedChapter: { deleteMany: transcodedChapterDeleteMany },
   };

   const prisma = {
      $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      transcodingJob: { deleteMany: transcodingJobDeleteMany },
      streamingSession: { deleteMany: streamingSessionDeleteMany },
      transcodedChapter: { deleteMany: transcodedChapterDeleteMany },
   };

   return { prisma, transcodingJobDeleteMany, streamingSessionDeleteMany, transcodedChapterDeleteMany };
}

describe('ChapterDeletionWorker', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('runs all three deleteMany calls inside one transaction', async () => {
      const { prisma, transcodingJobDeleteMany, streamingSessionDeleteMany, transcodedChapterDeleteMany } =
         createPrismaMock();

      const worker = new ChapterDeletionWorker(prisma as never);

      await (
         worker as unknown as {
            processChapterDeletion: (
               message: { chapterId: string; timestamp: string },
               raw: unknown
            ) => Promise<void>;
         }
      ).processChapterDeletion(
         { chapterId: 'chapter-123', timestamp: new Date().toISOString() },
         {}
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(transcodingJobDeleteMany).toHaveBeenCalledTimes(1);
      expect(streamingSessionDeleteMany).toHaveBeenCalledTimes(1);
      expect(transcodedChapterDeleteMany).toHaveBeenCalledTimes(1);
   });

   it('runs full cleanup even when no transcoded_chapters rows exist', async () => {
      const { prisma, transcodingJobDeleteMany, streamingSessionDeleteMany, transcodedChapterDeleteMany } =
         createPrismaMock();

      const worker = new ChapterDeletionWorker(prisma as never);

      await (
         worker as unknown as {
            processChapterDeletion: (
               message: { chapterId: string; timestamp: string },
               raw: unknown
            ) => Promise<void>;
         }
      ).processChapterDeletion(
         { chapterId: 'chapter-123', timestamp: new Date().toISOString() },
         {}
      );

      expect(mockRemoveJobsForChapter).toHaveBeenCalledWith('chapter-123');
      expect(mockClearChapterCache).toHaveBeenCalledWith('chapter-123');
      expect(mockCleanupChapterArtifacts).toHaveBeenCalledWith('chapter-123');
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(transcodingJobDeleteMany).toHaveBeenCalledWith({ where: { chapterId: 'chapter-123' } });
      expect(streamingSessionDeleteMany).toHaveBeenCalledWith({ where: { chapterId: 'chapter-123' } });
      expect(transcodedChapterDeleteMany).toHaveBeenCalledWith({ where: { chapterId: 'chapter-123' } });
   });

   it('propagates S3 cleanup errors so RabbitMQ can retry the message', async () => {
      mockCleanupChapterArtifacts.mockRejectedValueOnce(new Error('S3 cleanup failed'));

      const { prisma, transcodingJobDeleteMany, transcodedChapterDeleteMany } = createPrismaMock();

      const worker = new ChapterDeletionWorker(prisma as never);

      await expect(
         (
            worker as unknown as {
               processChapterDeletion: (
                  message: { chapterId: string; timestamp: string },
                  raw: unknown
               ) => Promise<void>;
            }
         ).processChapterDeletion(
            { chapterId: 'chapter-123', timestamp: new Date().toISOString() },
            {}
         )
      ).rejects.toThrow('S3 cleanup failed');

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(transcodingJobDeleteMany).not.toHaveBeenCalled();
      expect(transcodedChapterDeleteMany).not.toHaveBeenCalled();
   });
});
