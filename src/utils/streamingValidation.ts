export class ValidationError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'ValidationError';
   }
}

export function isNonEmptyChapterId(chapterId: unknown): chapterId is string {
   return typeof chapterId === 'string' && chapterId.trim().length > 0;
}

export function isNumericBitrate(bitrate: unknown): bitrate is number {
   if (typeof bitrate === 'number') {
      return Number.isFinite(bitrate) && bitrate > 0;
   }

   if (typeof bitrate === 'string') {
      const parsed = parseInt(bitrate, 10);
      return !Number.isNaN(parsed) && parsed > 0;
   }

   return false;
}

export function assertNonEmptyChapterId(chapterId: unknown): asserts chapterId is string {
   if (!isNonEmptyChapterId(chapterId)) {
      throw new ValidationError('Chapter ID is required');
   }
}

export function assertNumericBitrate(bitrate: unknown): asserts bitrate is number {
   if (!isNumericBitrate(bitrate)) {
      throw new ValidationError('Invalid bitrate');
   }
}

export function assertNumericBitrates(bitrates: unknown): asserts bitrates is number[] {
   if (!Array.isArray(bitrates) || !bitrates.length || !bitrates.every(isNumericBitrate)) {
      throw new ValidationError('Invalid bitrates');
   }
}
