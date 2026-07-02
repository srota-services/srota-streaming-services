/**
 * Bull Queue Configuration
 * Configuration for Bull job queues used for background transcoding
 */
import Bull from 'bull';
import { config } from './env';

// Queue names
export const QUEUE_NAMES = {
   BITRATE_64K: 'transcode:64k',
   BITRATE_128K: 'transcode:128k',
   BITRATE_256K: 'transcode:256k',
   MASTER_PLAYLIST: 'transcode:master'
} as const;

// Job data interfaces
export interface BitrateTranscodingJobData {
   chapterId: string;
   inputPath: string;
   outputDir: string;
   bitrate: number;
   segmentDuration: number;
   userId?: string;
}

export interface MasterPlaylistJobData {
   chapterId: string;
   audiobookId?: string;
   outputDir: string;
   variantBitrates: number[];
}

// Default job options
export const DEFAULT_JOB_OPTIONS: Bull.JobOptions = {
   attempts: config.BULL_MAX_ATTEMPTS,
   backoff: {
      type: 'exponential',
      delay: config.BULL_BACKOFF_DELAY
   },
   removeOnComplete: 10, // Keep last 10 completed jobs
   removeOnFail: 5, // Keep last 5 failed jobs
   timeout: config.BULL_JOB_TIMEOUT
};

// Queue configuration
export const QUEUE_CONFIG: Bull.QueueOptions = {
   redis: {
      host: config.BULL_REDIS_HOST.replace('redis://', '').split(':')[0],
      port: parseInt(config.BULL_REDIS_HOST.split(':')[2] || '6379'),
      password: config.REDIS_PASSWORD
   },
   defaultJobOptions: DEFAULT_JOB_OPTIONS
};

/**
 * Create a Bull queue with the given name and configuration
 */
export function createQueue(queueName: string): Bull.Queue {
   return new Bull(queueName, QUEUE_CONFIG);
}

/**
 * Get all queue names as an array
 */
export function getAllQueueNames(): string[] {
   return Object.values(QUEUE_NAMES);
}

/**
 * Get bitrate queue names only
 */
export function getBitrateQueueNames(): string[] {
   return [QUEUE_NAMES.BITRATE_64K, QUEUE_NAMES.BITRATE_128K, QUEUE_NAMES.BITRATE_256K];
}

/**
 * Get queue name for a specific bitrate
 */
export function getQueueNameForBitrate(bitrate: number): string {
   switch (bitrate) {
      case 64:
         return QUEUE_NAMES.BITRATE_64K;
      case 128:
         return QUEUE_NAMES.BITRATE_128K;
      case 256:
         return QUEUE_NAMES.BITRATE_256K;
      default:
         throw new Error(`Unsupported bitrate: ${bitrate}`);
   }
}
