import axios, { AxiosError } from 'axios';
import { config } from '../config/env';
import { SubscriptionTierLevel, isSubscriptionTierLevel } from '../constants/subscriptionTierLevel';

export class ChapterNotFoundError extends Error {
   constructor(chapterId: string) {
      super(`Chapter not found: ${chapterId}`);
      this.name = 'ChapterNotFoundError';
   }
}

export interface ChapterStreamGatingContext {
   chapterId: string;
   requiredTier: SubscriptionTierLevel | null;
}

export class ChapterGatingClient {
   private baseUrl: string;

   constructor(baseUrl: string = config.APP_SERVICE_URL) {
      this.baseUrl = baseUrl.replace(/\/$/, '');
   }

   async getChapterStreamGating(chapterId: string, accessToken: string): Promise<ChapterStreamGatingContext> {
      try {
         const response = await axios.get<{
            success: boolean;
            data: { chapterId: string; requiredTier: SubscriptionTierLevel | null };
         }>(`${this.baseUrl}/api/v1/chapters/${encodeURIComponent(chapterId)}/stream-gating`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 5000,
         });

         const requiredTier = response.data?.data?.requiredTier ?? null;
         return {
            chapterId: response.data?.data?.chapterId ?? chapterId,
            requiredTier:
               requiredTier === null
                  ? null
                  : isSubscriptionTierLevel(requiredTier)
                     ? requiredTier
                     : null,
         };
      } catch (error) {
         if (axios.isAxiosError(error) && (error as AxiosError).response?.status === 404) {
            throw new ChapterNotFoundError(chapterId);
         }
         throw error;
      }
   }
}

export const chapterGatingClient = new ChapterGatingClient();
