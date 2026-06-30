import axios, { AxiosError } from 'axios';
import { config } from '../config/env';
import { SubscriptionTierLevel, isSubscriptionTierLevel } from '../constants/subscriptionTierLevel';

export class SubscriptionClient {
   private baseUrl: string;

   constructor(baseUrl: string = config.AUTH_SERVICE_URL) {
      this.baseUrl = baseUrl.replace(/\/$/, '');
   }

   async getUserHighestActiveTier(_userId: string, accessToken: string): Promise<SubscriptionTierLevel | null> {
      try {
         const response = await axios.get<{ tier: SubscriptionTierLevel | null }>(
            `${this.baseUrl}/auth/subscriptions/me/tier`,
            {
               headers: { Authorization: `Bearer ${accessToken}` },
               timeout: 5000,
            },
         );
         const tier = response.data?.tier;
         if (tier === null || tier === undefined) {
            return null;
         }
         return isSubscriptionTierLevel(tier) ? tier : null;
      } catch (error) {
         if (axios.isAxiosError(error) && (error as AxiosError).response?.status === 401) {
            return null;
         }
         throw error;
      }
   }
}

export const subscriptionClient = new SubscriptionClient();
