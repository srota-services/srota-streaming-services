import { PrismaClient } from '@prisma/client';
import { runInTransaction } from './prismaTransaction';
import { rethrowServiceError } from './serviceError';
import { assertNonEmptyChapterId } from './streamingValidation';

export interface UpdateTranscodingJobStatusParams {
   chapterId: string;
   status: string;
   progress: number;
   errorMessage?: string;
   createIfMissing?: boolean;
}

export async function updateTranscodingJobStatus(
   prisma: PrismaClient,
   params: UpdateTranscodingJobStatusParams,
): Promise<void> {
   const { chapterId, status, progress, errorMessage, createIfMissing = true } = params;

   assertNonEmptyChapterId(chapterId);

   try {
      await runInTransaction(prisma, async tx => {
         const existingJob = await tx.transcodingJob.findFirst({
            where: { chapterId },
            orderBy: { createdAt: 'desc' },
         });

         const updateData = {
            status,
            progress,
            ...(errorMessage && { errorMessage }),
            ...(status === 'processing' && !existingJob?.startedAt && { startedAt: new Date() }),
            ...((status === 'completed' || status === 'failed') && { completedAt: new Date() }),
            updatedAt: new Date(),
         };

         if (existingJob) {
            await tx.transcodingJob.update({
               where: { id: existingJob.id },
               data: updateData,
            });
            return;
         }

         if (!createIfMissing) {
            return;
         }

         await tx.transcodingJob.create({
            data: {
               chapterId,
               status,
               progress,
               ...(errorMessage && { errorMessage }),
               ...(status === 'processing' && { startedAt: new Date() }),
               ...((status === 'completed' || status === 'failed') && { completedAt: new Date() }),
            },
         });
      });
   } catch (error: unknown) {
      rethrowServiceError(error, {
         operation: 'updateTranscodingJobStatus',
         chapterId,
         status,
      });
   }
}
