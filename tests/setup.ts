// Test setup file
// IMPORTANT: Set environment variables BEFORE any imports that depend on config

process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '8083';
process.env['TRUST_PROXY'] = '0';
process.env['SESSION_SECRET'] = 'test-session-secret';
process.env['HEALTH_SUPPORT_EMAIL'] = 'no-reply@srota-support.com';
process.env['HEALTH_SUPPORT_PASSWORD'] = 'test-health-password';

process.env['DATABASE_URL'] = 'postgresql://postgres:postgres@localhost:5432/test_db?schema=public';

process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['REDIS_PASSWORD'] = '';

process.env['RABBITMQ_URL'] = 'amqp://localhost:5672';
process.env['RABBITMQ_QUEUE_PREFIX'] = 'audiobook';
process.env['RABBITMQ_MESSAGE_TTL'] = '3600000';

process.env['BULL_REDIS_HOST'] = 'redis://localhost:6379';
process.env['BULL_JOB_TIMEOUT'] = '3600000';
process.env['BULL_MAX_ATTEMPTS'] = '3';
process.env['BULL_BACKOFF_DELAY'] = '30000';

process.env['STORAGE_PROVIDER'] = 's3';
process.env['LOCAL_STORAGE_PATH'] = './storage';
process.env['AWS_S3_BUCKET'] = '';
process.env['AWS_S3_REGION'] = '';
process.env['AWS_S3_ENDPOINT'] = '';
process.env['AWS_SIGNED_URL_EXPIRES_IN'] = '3600';
process.env['HLS_PRESIGNED_URL_EXPIRES_IN'] = '7200';

process.env['FFMPEG_PATH'] = 'ffmpeg';
process.env['FFPROBE_PATH'] = 'ffprobe';

process.env['HLS_SEGMENT_DURATION'] = '4';
process.env['TRANSCODING_BITRATES'] = '[64, 128, 256]';
process.env['STREAMING_CACHE_TTL'] = '3600';
process.env['STREAMING_BASE_URL'] = 'http://localhost:8083';

process.env['RATE_LIMIT_WINDOW_MS'] = '900000';
process.env['RATE_LIMIT_MAX_REQUESTS'] = '100';

process.env['LOG_LEVEL'] = 'error';
process.env['LOG_DIR'] = './logs';

process.env['HEALTH_CHECK_INTERVAL'] = '30000';
process.env['TRANSCODING_TIMEOUT'] = '3600000';
process.env['MAX_TRANSCODING_WORKERS'] = '2';
process.env['CACHE_TTL'] = '3600';

process.env['AUTH_SERVICE_URL'] = 'http://localhost:8080';
process.env['APP_SERVICE_URL'] = 'http://localhost:8081';
process.env['JWKS_ENDPOINT'] = 'http://localhost:8080/auth/.well-known/jwks.json';

jest.setTimeout(10000);

global.console = {
   ...console,
   log: jest.fn(),
   debug: jest.fn(),
   info: jest.fn(),
   warn: jest.fn(),
   error: jest.fn(),
};
