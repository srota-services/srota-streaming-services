export type SubscriptionTierLevel = 'BASE' | 'STANDARD' | 'PREMIUM';

export const SUBSCRIPTION_TIER_ORDER: Record<SubscriptionTierLevel, number> = {
   BASE: 1,
   STANDARD: 2,
   PREMIUM: 3,
};

export const ALL_TIER_LEVELS: SubscriptionTierLevel[] = ['BASE', 'STANDARD', 'PREMIUM'];

export function isSubscriptionTierLevel(value: unknown): value is SubscriptionTierLevel {
   return typeof value === 'string' && ALL_TIER_LEVELS.includes(value as SubscriptionTierLevel);
}
