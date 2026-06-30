import { SubscriptionTierLevel } from '../constants/subscriptionTierLevel';

export interface SubscriptionAccessDto {
   canAccess: boolean;
   message?: string;
   requiredTier?: SubscriptionTierLevel | null;
   userTier?: SubscriptionTierLevel | null;
}
