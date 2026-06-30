/**
 * Swagger/OpenAPI configuration for streaming-service
 */
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { Express } from 'express';
import { config } from './env';

const options: swaggerJsdoc.Options = {
   definition: {
      openapi: '3.0.0',
      info: {
         title: 'Srota Streaming Service API',
         version: '1.0.0',
         description: 'HLS audio streaming, chapter status, preload, and analytics.',
      },
      servers: [
         {
            url: `http://localhost:${config.PORT}`,
            description: 'Development server',
         },
      ],
      components: {
         securitySchemes: {
            bearerAuth: {
               type: 'http',
               scheme: 'bearer',
               bearerFormat: 'JWT',
               description: 'JWT access token (Authorization: Bearer <token>)',
            },
            healthBasicAuth: {
               type: 'http',
               scheme: 'basic',
               description: 'Support credentials for health endpoints',
            },
         },
         schemas: {
            ApiResponse: {
               type: 'object',
               properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Operation successful' },
                  data: { type: 'object' },
                  timestamp: { type: 'string', format: 'date-time', example: '2024-01-15T10:30:00Z' },
                  statusCode: { type: 'integer', example: 200 },
               },
            },
            ErrorResponse: {
               type: 'object',
               properties: {
                  success: { type: 'boolean', example: false },
                  message: { type: 'string', example: 'Request failed' },
                  timestamp: { type: 'string', format: 'date-time', example: '2024-01-15T10:30:00Z' },
                  statusCode: { type: 'integer', example: 400 },
               },
            },
            StreamingStatus: {
               type: 'object',
               required: ['chapterId', 'availableBitrates', 'transcodingStatus', 'canStream', 'aggregateStatus', 'bitrates'],
               properties: {
                  chapterId: { type: 'string', example: 'cchapter1234567890abcdef' },
                  availableBitrates: { type: 'array', items: { type: 'integer' }, example: [64, 128, 256] },
                  transcodingStatus: {
                     type: 'string',
                     example: 'processing',
                     description: 'Aggregate transcoding status',
                  },
                  aggregateStatus: {
                     type: 'string',
                     enum: ['not_started', 'processing', 'completed', 'partial', 'failed'],
                     example: 'processing',
                  },
                  canStream: { type: 'boolean', example: false },
                  masterPlaylistReady: { type: 'boolean', example: false },
                  estimatedBandwidth: {
                     type: 'integer',
                     example: 192000,
                     description: 'Estimated bandwidth in bps; 0 when no bitrates available',
                  },
                  bitrates: {
                     type: 'array',
                     items: { $ref: '#/components/schemas/BitrateTranscodingStatus' },
                  },
               },
            },
            BitrateTranscodingStatus: {
               type: 'object',
               required: ['bitrate', 'status', 'progress'],
               properties: {
                  bitrate: { type: 'integer', example: 128 },
                  status: {
                     type: 'string',
                     enum: ['pending', 'processing', 'completed', 'failed'],
                     example: 'processing',
                  },
                  progress: { type: 'number', example: 47, minimum: 0, maximum: 100 },
                  errorMessage: { type: 'string', nullable: true },
               },
            },
            ChapterTranscodingStatusDetail: {
               type: 'object',
               required: ['chapterId', 'canStream', 'masterPlaylistReady', 'aggregateStatus', 'bitrates'],
               properties: {
                  chapterId: { type: 'string' },
                  canStream: { type: 'boolean' },
                  masterPlaylistReady: { type: 'boolean' },
                  aggregateStatus: {
                     type: 'string',
                     enum: ['not_started', 'processing', 'completed', 'partial', 'failed'],
                  },
                  bitrates: {
                     type: 'array',
                     items: { $ref: '#/components/schemas/BitrateTranscodingStatus' },
                  },
               },
            },
            TranscodingEvent: {
               type: 'object',
               required: ['chapterId', 'bitrate', 'status', 'progress', 'timestamp'],
               properties: {
                  chapterId: { type: 'string' },
                  bitrate: { type: 'integer', example: 128 },
                  status: {
                     type: 'string',
                     enum: ['pending', 'processing', 'completed', 'failed'],
                  },
                  progress: { type: 'integer', example: 47 },
                  errorMessage: { type: 'string', nullable: true },
                  timestamp: { type: 'string', format: 'date-time' },
               },
            },
            RetryTranscodingRequest: {
               type: 'object',
               properties: {
                  bitrates: {
                     type: 'array',
                     items: { type: 'integer' },
                     description: 'Optional bitrates to retry (defaults to all failed)',
                  },
                  inputPath: {
                     type: 'string',
                     description: 'Source audio path (injected by app-service proxy)',
                  },
               },
            },
            PreloadResult: {
               type: 'object',
               required: ['chapterId', 'bitrate', 'status'],
               properties: {
                  chapterId: { type: 'string', example: 'cchapter1234567890abcdef' },
                  bitrate: { type: 'integer', example: 128 },
                  status: { type: 'string', example: 'preloaded' },
               },
            },
            StreamingAnalytics: {
               type: 'object',
               properties: {
                  totalRequests: { type: 'integer', example: 1000 },
                  cacheHitRate: { type: 'number', example: 0.85 },
                  averageBandwidth: { type: 'integer', example: 128000 },
                  popularBitrates: {
                     type: 'array',
                     items: {
                        type: 'object',
                        properties: {
                           bitrate: { type: 'integer', example: 128 },
                           requests: { type: 'integer', example: 42 },
                        },
                     },
                  },
               },
            },
            HealthStatus: {
               type: 'object',
               properties: {
                  status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'], example: 'healthy' },
                  service: { type: 'string', example: 'audio-streaming' },
                  timestamp: { type: 'string', format: 'date-time', example: '2024-01-15T10:30:00Z' },
                  components: {
                     type: 'object',
                     properties: {
                        database: { type: 'boolean', example: true },
                        redis: { type: 'boolean', example: true },
                        rabbitmq: { type: 'boolean', example: true },
                        storage: { type: 'boolean', example: true },
                        ffmpeg: { type: 'boolean', example: true },
                        bullWorkers: { type: 'boolean', example: true },
                     },
                  },
               },
            },
         },
         responses: {
            Unauthorized: {
               description: 'Authentication required',
               content: {
                  'application/json': {
                     schema: { $ref: '#/components/schemas/ApiResponse' },
                     example: { success: false, message: 'Unauthorized', timestamp: '2024-01-15T10:30:00Z' },
                  },
               },
            },
            Forbidden: {
               description: 'Subscription gating denied (LISTENER role) or guest streaming blocked',
               content: {
                  'application/json': {
                     schema: { $ref: '#/components/schemas/ErrorResponse' },
                     example: {
                        success: false,
                        error: 'Forbidden',
                        message: 'Your plan does not include this chapter. Upgrade to listen',
                        statusCode: 403,
                     },
                  },
               },
            },
            NotFound: {
               description: 'Chapter or resource not found',
               content: {
                  'application/json': {
                     schema: { $ref: '#/components/schemas/ApiResponse' },
                  },
               },
            },
         },
      },
      tags: [
         { name: 'Streaming', description: 'HLS playlists, segments, status, and preload' },
         { name: 'Analytics', description: 'Streaming usage analytics' },
         { name: 'Health', description: 'Service health checks' },
      ],
   },
   apis: ['./src/docs/*.ts', './src/controllers/*.ts', './src/routes/*.ts'],
};

const specs = swaggerJsdoc(options);

export const setupSwagger = (app: Express): void => {
   app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs, {
      explorer: true,
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Srota Streaming Service API',
      swaggerOptions: {
         persistAuthorization: true,
         displayRequestDuration: true,
         filter: true,
      },
   }));

   app.get('/api-docs.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(specs);
   });
};

export { specs };
