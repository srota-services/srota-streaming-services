/**
 * MasterPlaylistProcessor transcoding completion publish tests
 */

import Bull from 'bull';
import { MasterPlaylistJobData } from '../src/config/bull';
import { MasterPlaylistProcessor } from '../src/workers/MasterPlaylistProcessor';
import { RabbitMQFactory } from '../src/config/rabbitmq';
import { updateTranscodingJobStatus } from '../src/utils/transcodingJobStatus';

jest.mock('../src/config/rabbitmq');
jest.mock('../src/utils/transcodingJobStatus');
jest.mock('../src/config/logger', () => ({
   bullLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
   logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

describe('MasterPlaylistProcessor', () => {
   const mockPublish = jest.fn().mockResolvedValue(true);
   const mockFindMany = jest.fn();
   const mockTranscodingService = {
      generateMasterPlaylist: jest.fn().mockReturnValue('#EXTM3U\n'),
      initializeStorageProvider: jest.fn().mockResolvedValue(undefined),
      storageProvider: {
         uploadFile: jest.fn().mockResolvedValue(undefined),
      },
   };

   beforeEach(() => {
      jest.clearAllMocks();
      (RabbitMQFactory.getConnection as jest.Mock).mockReturnValue({
         publishChapterTranscodingCompleted: mockPublish,
      });
      (updateTranscodingJobStatus as jest.Mock).mockResolvedValue(undefined);
   });

   function createProcessor(): MasterPlaylistProcessor {
      const prisma = {
         transcodedChapter: {
            findMany: mockFindMany,
         },
      } as unknown as ConstructorParameters<typeof MasterPlaylistProcessor>[0];

      const processor = new MasterPlaylistProcessor(prisma);
      (processor as unknown as { transcodingService: typeof mockTranscodingService }).transcodingService =
         mockTranscodingService;
      return processor;
   }

   function createJob(data: MasterPlaylistJobData): Bull.Job<MasterPlaylistJobData> {
      return {
         data,
         progress: jest.fn().mockResolvedValue(undefined),
      } as unknown as Bull.Job<MasterPlaylistJobData>;
   }

   it('publishes chapter.transcoding.completed when all bitrates succeed', async () => {
      mockFindMany.mockResolvedValue([
         { bitrate: 64, status: 'completed' },
         { bitrate: 128, status: 'completed' },
         { bitrate: 256, status: 'completed' },
      ]);

      const processor = createProcessor();
      jest.spyOn(processor as unknown as { waitForBitrateJobs: () => Promise<number[]> }, 'waitForBitrateJobs')
         .mockResolvedValue([64, 128, 256]);

      await processor.processMasterPlaylist(
         createJob({
            chapterId: 'chapter-1',
            audiobookId: 'book-1',
            outputDir: 'bit_transcode/chapter-1',
            variantBitrates: [64, 128, 256],
         }),
      );

      expect(mockPublish).toHaveBeenCalledWith(
         expect.objectContaining({
            chapterId: 'chapter-1',
            audiobookId: 'book-1',
            bitrates: [64, 128, 256],
            status: 'completed',
         }),
      );
      expect(updateTranscodingJobStatus).toHaveBeenCalledWith(
         expect.anything(),
         expect.objectContaining({ chapterId: 'chapter-1', status: 'completed' }),
      );
   });

   it('does not publish when not all bitrates completed', async () => {
      const processor = createProcessor();
      jest.spyOn(processor as unknown as { waitForBitrateJobs: () => Promise<number[]> }, 'waitForBitrateJobs')
         .mockResolvedValue([64, 128]);

      await expect(
         processor.processMasterPlaylist(
            createJob({
               chapterId: 'chapter-1',
               audiobookId: 'book-1',
               outputDir: 'bit_transcode/chapter-1',
               variantBitrates: [64, 128, 256],
            }),
         ),
      ).rejects.toThrow(/Not all bitrates completed/);

      expect(mockPublish).not.toHaveBeenCalled();
      expect(updateTranscodingJobStatus).toHaveBeenCalledWith(
         expect.anything(),
         expect.objectContaining({ chapterId: 'chapter-1', status: 'failed' }),
      );
   });
});
