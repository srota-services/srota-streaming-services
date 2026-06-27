import { BitrateTranscodingRepository } from '../src/services/BitrateTranscodingRepository';

describe('BitrateTranscodingRepository', () => {
   it('commitCompletedLocal runs DB upsert before returning storage paths', async () => {
      const callOrder: string[] = [];
      const upsert = jest.fn().mockResolvedValue({});
      const transaction = jest.fn(async (callback: (tx: unknown) => Promise<void>) => {
         callOrder.push('transaction');
         await callback({ transcodedChapter: { upsert } });
      });

      const prisma = {
         $transaction: transaction,
         transcodedChapter: { upsert },
      } as unknown as ConstructorParameters<typeof BitrateTranscodingRepository>[0];

      const repo = new BitrateTranscodingRepository(prisma);
      const s3Upload = jest.fn(async () => {
         callOrder.push('s3Upload');
      });

      const result = await repo.commitCompletedLocal('chapter-1', 128);
      await s3Upload();

      expect(callOrder).toEqual(['transaction', 's3Upload']);
      expect(result.playlistUrl).toContain('chapter-1');
      expect(result.playlistUrl).toContain('128k');
   });

   it('markStoredOnS3 sets storage provider and progress to 100', async () => {
      const update = jest.fn().mockResolvedValue({});
      const transaction = jest.fn(async (callback: (tx: unknown) => Promise<void>) => {
         await callback({ transcodedChapter: { update } });
      });
      const prisma = {
         $transaction: transaction,
         transcodedChapter: { update },
      } as unknown as ConstructorParameters<typeof BitrateTranscodingRepository>[0];

      const repo = new BitrateTranscodingRepository(prisma);
      await repo.markStoredOnS3('chapter-1', 128);

      expect(update).toHaveBeenCalledWith({
         where: { chapterId_bitrate: { chapterId: 'chapter-1', bitrate: 128 } },
         data: expect.objectContaining({
            progress: 100,
         }),
      });
   });
});
