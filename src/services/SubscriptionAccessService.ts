import { SubscriptionClient, subscriptionClient } from '../clients/SubscriptionClient';
import { SubscriptionAccessDto } from '../models/SubscriptionAccessDto';
import { MessageHandler } from '../utils/MessageHandler';
import { isListenerRole } from '../constants/authRoles';
import { SUBSCRIPTION_TIER_ORDER, SubscriptionTierLevel } from '../constants/subscriptionTierLevel';

export class SubscriptionAccessService {
   private subscriptionClient: SubscriptionClient;

   constructor(subscriptionClientInstance: SubscriptionClient = subscriptionClient) {
      this.subscriptionClient = subscriptionClientInstance;
   }

   /**
    * Evaluate stream access for LISTENER users only.
    * Non-LISTENER roles bypass subscription tier checks (handled by middleware).
    */
   async evaluateListenerStreamAccess(
      requiredTier: SubscriptionTierLevel | null,
      userId: string,
      accessToken: string,
      userRole: string | undefined,
   ): Promise<SubscriptionAccessDto> {
      if (!isListenerRole(userRole)) {
         return { canAccess: true, ...(requiredTier !== null ? { requiredTier } : {}) };
      }

      if (requiredTier === null) {
         return { canAccess: true };
      }

      const userTier = await this.subscriptionClient.getUserHighestActiveTier(userId, accessToken);
      if (userTier === null) {
         return {
            canAccess: false,
            message: MessageHandler.getErrorMessage('subscription_required'),
            requiredTier,
            userTier: null,
         };
      }

      if (SUBSCRIPTION_TIER_ORDER[userTier] < SUBSCRIPTION_TIER_ORDER[requiredTier]) {
         return {
            canAccess: false,
            message: MessageHandler.getErrorMessage('subscription_tier_too_low_chapter'),
            requiredTier,
            userTier,
         };
      }

      return { canAccess: true, requiredTier, userTier };
   }
}

export const subscriptionAccessService = new SubscriptionAccessService();
