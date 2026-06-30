import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

const LOCALHOST_PATTERN = /localhost|127\.0\.0\.1/i;

const ENV_FILE_BY_NODE_ENV: Record<string, string | null> = {
   development: '.env.development',
   test: null,
   testing: '.env.testing',
   staging: '.env.staging',
   production: '.env.production',
};

function getEnvFileForBootstrap(): string | null {
   const bootstrapEnv = process.env['NODE_ENV'] ?? 'development';
   return ENV_FILE_BY_NODE_ENV[bootstrapEnv] ?? `.env.${bootstrapEnv}`;
}

function loadEnvFile(filename: string, override = false): void {
   const filePath = path.resolve(process.cwd(), filename);
   if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override });
   }
}

function loadEnvFiles(): void {
   loadEnvFile('.env');
   const envFile = getEnvFileForBootstrap();
   if (envFile) {
      loadEnvFile(envFile, true);
   }
   loadEnvFile('.env.local', true);
}

function requireEnv(key: string): string {
   const value = process.env[key];
   if (value === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
   }
   return value;
}

function requireIntEnv(key: string): number {
   const raw = requireEnv(key);
   const parsed = parseInt(raw, 10);
   if (Number.isNaN(parsed)) {
      throw new Error(`Environment variable ${key} must be a valid integer`);
   }
   return parsed;
}

function requireOptionalIntEnv(key: string, defaultValue: number): number {
   const raw = process.env[key];
   if (raw === undefined || raw.trim() === '') {
      return defaultValue;
   }
   const parsed = parseInt(raw, 10);
   if (Number.isNaN(parsed)) {
      throw new Error(`Environment variable ${key} must be a valid integer`);
   }
   return parsed;
}

function parseTranscodingBitrates(raw: string): number[] {
   const envValue = raw.trim();

   if (envValue.startsWith('[') && envValue.endsWith(']')) {
      try {
         const parsed = JSON.parse(envValue);
         if (Array.isArray(parsed)) {
            const bitrates = parsed
               .map(b => (typeof b === 'number' ? b : parseInt(String(b), 10)))
               .filter(b => !Number.isNaN(b) && b > 0);
            if (bitrates.length > 0) {
               return bitrates;
            }
         }
      } catch {
         // Fall through to comma-separated parsing
      }
   }

   const bitrates = envValue
      .split(',')
      .map(b => b.trim())
      .filter(b => b.length > 0)
      .map(b => parseInt(b, 10))
      .filter(b => !Number.isNaN(b) && b > 0);

   if (bitrates.length === 0) {
      throw new Error('TRANSCODING_BITRATES must contain at least one valid positive integer');
   }

   return bitrates;
}

function assertNoLocalhost(envVar: string, value: string, nodeEnv: string): void {
   if (LOCALHOST_PATTERN.test(value)) {
      throw new Error(`${envVar} must not reference localhost in ${nodeEnv}`);
   }
}

const HEALTH_SUPPORT_EMAIL_DOMAIN = '@srota-support.com';

function validateHealthSupportEmail(email: string): void {
   if (!email.toLowerCase().endsWith(HEALTH_SUPPORT_EMAIL_DOMAIN)) {
      throw new Error(`HEALTH_SUPPORT_EMAIL must end with ${HEALTH_SUPPORT_EMAIL_DOMAIN}`);
   }
}

function validateNoLocalhostInStagingOrProduction(
   nodeEnv: string,
   values: {
      DATABASE_URL: string;
      REDIS_URL: string;
      RABBITMQ_URL: string;
      STREAMING_BASE_URL: string;
      AUTH_SERVICE_URL: string;
      APP_SERVICE_URL: string;
      JWKS_ENDPOINT: string;
   }
): void {
   if (nodeEnv !== 'staging' && nodeEnv !== 'production') {
      return;
   }

   assertNoLocalhost('DATABASE_URL', values.DATABASE_URL, nodeEnv);
   assertNoLocalhost('REDIS_URL', values.REDIS_URL, nodeEnv);
   assertNoLocalhost('RABBITMQ_URL', values.RABBITMQ_URL, nodeEnv);
   assertNoLocalhost('STREAMING_BASE_URL', values.STREAMING_BASE_URL, nodeEnv);
   assertNoLocalhost('AUTH_SERVICE_URL', values.AUTH_SERVICE_URL, nodeEnv);
   assertNoLocalhost('APP_SERVICE_URL', values.APP_SERVICE_URL, nodeEnv);
   assertNoLocalhost('JWKS_ENDPOINT', values.JWKS_ENDPOINT, nodeEnv);
}

loadEnvFiles();

const nodeEnv = requireEnv('NODE_ENV');

const DATABASE_URL = requireEnv('DATABASE_URL');
const REDIS_URL = requireEnv('REDIS_URL');
const RABBITMQ_URL = requireEnv('RABBITMQ_URL');
const STREAMING_BASE_URL = requireEnv('STREAMING_BASE_URL');
const AUTH_SERVICE_URL = requireEnv('AUTH_SERVICE_URL');
const APP_SERVICE_URL = requireEnv('APP_SERVICE_URL');
const JWKS_ENDPOINT = requireEnv('JWKS_ENDPOINT');
const STORAGE_PROVIDER = requireEnv('STORAGE_PROVIDER');

validateNoLocalhostInStagingOrProduction(nodeEnv, {
   DATABASE_URL,
   REDIS_URL,
   RABBITMQ_URL,
   STREAMING_BASE_URL,
   AUTH_SERVICE_URL,
   APP_SERVICE_URL,
   JWKS_ENDPOINT,
});

if (nodeEnv !== 'development' && STORAGE_PROVIDER !== 's3') {
   throw new Error(`STORAGE_PROVIDER must be s3 when NODE_ENV is ${nodeEnv}`);
}

const USE_SECURE_COOKIES = nodeEnv === 'production' || nodeEnv === 'staging' || nodeEnv === 'testing';

const HEALTH_SUPPORT_EMAIL = requireEnv('HEALTH_SUPPORT_EMAIL');
const HEALTH_SUPPORT_PASSWORD = requireEnv('HEALTH_SUPPORT_PASSWORD');
validateHealthSupportEmail(HEALTH_SUPPORT_EMAIL);

const AWS_SIGNED_URL_EXPIRES_IN = requireIntEnv('AWS_SIGNED_URL_EXPIRES_IN');
const HLS_PRESIGNED_URL_EXPIRES_IN = requireOptionalIntEnv('HLS_PRESIGNED_URL_EXPIRES_IN', 7200);

export const config = {
   NODE_ENV: nodeEnv,
   PORT: requireIntEnv('PORT'),
   TRUST_PROXY: requireIntEnv('TRUST_PROXY'),
   USE_SECURE_COOKIES,
   SESSION_SECRET: requireEnv('SESSION_SECRET'),

   DATABASE_URL,
   REDIS_URL,
   REDIS_PASSWORD: requireEnv('REDIS_PASSWORD'),

   RABBITMQ_URL,
   RABBITMQ_QUEUE_PREFIX: requireEnv('RABBITMQ_QUEUE_PREFIX'),
   RABBITMQ_MESSAGE_TTL: requireIntEnv('RABBITMQ_MESSAGE_TTL'),

   BULL_REDIS_HOST: requireEnv('BULL_REDIS_HOST'),
   BULL_JOB_TIMEOUT: requireIntEnv('BULL_JOB_TIMEOUT'),
   BULL_MAX_ATTEMPTS: requireIntEnv('BULL_MAX_ATTEMPTS'),
   BULL_BACKOFF_DELAY: requireIntEnv('BULL_BACKOFF_DELAY'),

   STORAGE_PROVIDER,
   LOCAL_STORAGE_PATH: requireEnv('LOCAL_STORAGE_PATH'),
   AWS_S3_BUCKET: requireEnv('AWS_S3_BUCKET'),
   AWS_S3_REGION: requireEnv('AWS_S3_REGION'),
   AWS_S3_ENDPOINT: requireEnv('AWS_S3_ENDPOINT'),
   AWS_SIGNED_URL_EXPIRES_IN,
   HLS_PRESIGNED_URL_EXPIRES_IN,

   FFMPEG_PATH: requireEnv('FFMPEG_PATH'),
   FFPROBE_PATH: requireEnv('FFPROBE_PATH'),

   HLS_SEGMENT_DURATION: requireIntEnv('HLS_SEGMENT_DURATION'),
   TRANSCODING_BITRATES: parseTranscodingBitrates(requireEnv('TRANSCODING_BITRATES')),
   STREAMING_CACHE_TTL: requireIntEnv('STREAMING_CACHE_TTL'),
   STREAMING_BASE_URL,

   RATE_LIMIT_WINDOW_MS: requireIntEnv('RATE_LIMIT_WINDOW_MS'),
   RATE_LIMIT_MAX_REQUESTS: requireIntEnv('RATE_LIMIT_MAX_REQUESTS'),

   LOG_LEVEL: requireEnv('LOG_LEVEL'),
   LOG_DIR: requireEnv('LOG_DIR'),

   HEALTH_CHECK_INTERVAL: requireIntEnv('HEALTH_CHECK_INTERVAL'),
   TRANSCODING_TIMEOUT: requireIntEnv('TRANSCODING_TIMEOUT'),
   MAX_TRANSCODING_WORKERS: requireIntEnv('MAX_TRANSCODING_WORKERS'),
   CACHE_TTL: requireIntEnv('CACHE_TTL'),

   AUTH_SERVICE_URL,
   APP_SERVICE_URL,
   JWKS_ENDPOINT,

   HEALTH_SUPPORT_EMAIL,
   HEALTH_SUPPORT_PASSWORD,
};
