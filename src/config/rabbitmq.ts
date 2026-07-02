import amqp from 'amqplib';
import { config } from './env';
import { rabbitmqLogger } from './logger';
export interface TranscodingJobData {
   // Chapter object (nested)
   chapter: {
      id: string;
      audiobookId: string;
      title: string;
      description?: string;
      chapterNumber: number;
      duration: number;
      filePath: string;
      fileSize: number;
      startPosition: number;
      endPosition: number;
      createdAt: Date;
      updatedAt: Date;
   };

   // Job-specific fields
   bitrates: number[];
   priority: 'low' | 'normal' | 'high';
   userId?: string;
   retryCount?: number;
   forceRetranscode?: boolean;
}

import { ChapterDeletionMessage, ChapterTranscodingCompletedMessage } from '../types/chapter-events';

export type { ChapterDeletionMessage, ChapterTranscodingCompletedMessage };

export function getChapterDeletionQueueName(): string {
   return `${config.RABBITMQ_QUEUE_PREFIX}.chapters.deleted`;
}

export function getChapterTranscodingCompletedQueueName(): string {
   return `${config.RABBITMQ_QUEUE_PREFIX}.chapters.transcoding.completed`;
}

export class RabbitMQConnection {
   private static instance: RabbitMQConnection;
   private connection: amqp.Connection | null = null;
   private channel: amqp.Channel | null = null;
   private isConnecting = false;
   private reconnectAttempts = 0;
   private maxReconnectAttempts = 10;
   private reconnectDelay = 5000; // 5 seconds

   private constructor() { }

   /**
    * Get RabbitMQ connection instance
    */
   public static getInstance(): RabbitMQConnection {
      if (!RabbitMQConnection.instance) {
         RabbitMQConnection.instance = new RabbitMQConnection();
      }
      return RabbitMQConnection.instance;
   }

   /**
    * Connect to RabbitMQ
    */
   public async connect(): Promise<void> {
      if (this.connection && this.channel) {
         return;
      }

      if (this.isConnecting) {
         return;
      }

      this.isConnecting = true;

      try {
         rabbitmqLogger.info('Connecting to RabbitMQ...');
         this.connection = await amqp.connect(config.RABBITMQ_URL) as unknown as amqp.Connection;

         this.connection!.on('error', (error: Error) => {
            rabbitmqLogger.error({ err: error }, 'RabbitMQ connection error');
            this.handleConnectionError();
         });

         this.connection!.on('close', () => {
            rabbitmqLogger.warn('RabbitMQ connection closed');
            this.handleConnectionError();
         });

         this.channel = await (this.connection as any).createChannel();

         // Set prefetch to prevent overwhelming workers
         await this.channel!.prefetch(1);

         rabbitmqLogger.info('Connected to RabbitMQ successfully');
         this.reconnectAttempts = 0;
         this.isConnecting = false;

         // Setup exchanges and queues
         await this.setupExchangesAndQueues();

      } catch (error) {
         rabbitmqLogger.error({ err: error }, 'Failed to connect to RabbitMQ');
         this.isConnecting = false;
         await this.handleConnectionError();
         throw error;
      }
   }

   /**
    * Setup exchanges and queues
    */
   private async setupExchangesAndQueues(): Promise<void> {
      if (!this.channel) {
         throw new Error('Channel not available');
      }

      try {
         // Main transcoding exchange
         await this.channel.assertExchange('transcoding.exchange', 'direct', {
            durable: true,
            autoDelete: false
         });

         // Try to create queues with TTL first, fallback to basic configuration if conflicts exist
         const queuePrefix = config.RABBITMQ_QUEUE_PREFIX;
         const queues = [
            `${queuePrefix}.transcode.priority`,
            `${queuePrefix}.transcode.normal`,
            `${queuePrefix}.transcode.low`,
         ];

         for (const queueName of queues) {
            await this.assertQueueWithFallback(queueName);
         }

         // Setup chapter deletion queue and bind to chapters exchange
         const chapterDeletionQueue = getChapterDeletionQueueName();
         await this.channel.assertExchange('chapters', 'topic', {
            durable: true,
            autoDelete: false,
         });
         await this.assertQueueWithFallback(chapterDeletionQueue);
         await this.channel.bindQueue(chapterDeletionQueue, 'chapters', 'chapter.deleted');

         const chapterTranscodingCompletedQueue = getChapterTranscodingCompletedQueueName();
         await this.assertQueueWithFallback(chapterTranscodingCompletedQueue);
         await this.channel.bindQueue(chapterTranscodingCompletedQueue, 'chapters', 'chapter.transcoding.completed');

         // Bind transcoding queues to exchange
         await this.channel.bindQueue(`${queuePrefix}.transcode.priority`, 'transcoding.exchange', 'priority');
         await this.channel.bindQueue(`${queuePrefix}.transcode.normal`, 'transcoding.exchange', 'normal');
         await this.channel.bindQueue(`${queuePrefix}.transcode.low`, 'transcoding.exchange', 'low');

         rabbitmqLogger.info('RabbitMQ exchanges and queues setup completed');
      } catch (error: any) {
         rabbitmqLogger.error({ err: error }, 'Error setting up exchanges and queues');
         throw error;
      }
   }

   /**
    * Assert queue with fallback to basic configuration if TTL conflicts exist
    */
   private async assertQueueWithFallback(queueName: string): Promise<void> {
      if (!this.channel) {
         throw new Error('Channel not available');
      }

      // Different queues may have different TTL configurations
      // Map queue names to their expected TTL values
      const queueTTLMap: { [key: string]: number } = {
         [`${config.RABBITMQ_QUEUE_PREFIX}.transcode.priority`]: 3600000, // 1 hour
         [`${config.RABBITMQ_QUEUE_PREFIX}.transcode.normal`]: 3600000,    // 1 hour
         [`${config.RABBITMQ_QUEUE_PREFIX}.transcode.low`]: 7200000,       // 2 hours
         [getChapterDeletionQueueName()]: 3600000,     // 1 hour (matches existing queue configuration)
         [getChapterTranscodingCompletedQueueName()]: 3600000,
      };

      const ttl = queueTTLMap[queueName] || config.RABBITMQ_MESSAGE_TTL;

      const configWithTTL = {
         durable: true,
         exclusive: false,
         autoDelete: false,
         arguments: {
            'x-message-ttl': ttl
         }
      };

      // Basic configuration without TTL (used as fallback)
      const configWithoutTTL = {
         durable: true,
         exclusive: false,
         autoDelete: false
      };

      try {
         await this.channel.assertQueue(queueName, configWithTTL);
         rabbitmqLogger.info({ queueName, ttl }, 'Successfully connected to queue with TTL');
      } catch (error: any) {
         if (error.code === 406) {
            rabbitmqLogger.warn(
               { queueName },
               'Queue already exists with different TTL; attempting to connect without TTL configuration'
            );
            try {
               await this.channel.assertQueue(queueName, configWithoutTTL);
               rabbitmqLogger.info({ queueName }, 'Successfully connected to existing queue using existing TTL configuration');
            } catch (fallbackError: any) {
               rabbitmqLogger.error({ err: fallbackError, queueName }, 'Failed to connect to queue even without TTL');
               throw fallbackError;
            }
         } else {
            rabbitmqLogger.error({ err: error, queueName }, 'Failed to connect to queue');
            throw error;
         }
      }
   }

   /**
    * Publish transcoding job
    */
   public async publishTranscodingJob(
      jobData: TranscodingJobData,
      priority: 'low' | 'normal' | 'high' = 'normal'
   ): Promise<boolean> {
      if (!this.channel) {
         throw new Error('Channel not available');
      }

      const routingKey = priority;

      try {
         const message = Buffer.from(JSON.stringify({
            ...jobData,
            priority,
            timestamp: new Date().toISOString(),
            retryCount: jobData.retryCount || 0
         }));

         const published = this.channel.publish(
            'transcoding.exchange',
            routingKey,
            message,
            {
               persistent: true,
               priority: priority === 'high' ? 10 : priority === 'normal' ? 5 : 1,
               messageId: `${jobData.chapter.id}-${Date.now()}`
            }
         );

         if (published) {
            rabbitmqLogger.info({ chapterId: jobData.chapter.id, priority }, 'Transcoding job published');
            return true;
         } else {
            rabbitmqLogger.error('Failed to publish transcoding job - channel buffer full');
            return false;
         }
      } catch (error) {
         rabbitmqLogger.error({ err: error }, 'Error publishing transcoding job');
         return false;
      }
   }

   /**
    * Publish chapter transcoding completed event (streaming → app-service)
    */
   public async publishChapterTranscodingCompleted(
      message: ChapterTranscodingCompletedMessage,
   ): Promise<boolean> {
      if (!this.channel) {
         throw new Error('Channel not available');
      }

      const routingKey = 'chapter.transcoding.completed';

      try {
         const payload = Buffer.from(JSON.stringify(message));

         const published = this.channel.publish(
            'chapters',
            routingKey,
            payload,
            {
               persistent: true,
               messageId: `chapter-transcoding-completed-${message.chapterId}-${Date.now()}`,
            },
         );

         if (published) {
            rabbitmqLogger.info(
               { chapterId: message.chapterId, audiobookId: message.audiobookId },
               'Chapter transcoding completed event published',
            );
            return true;
         }

         rabbitmqLogger.error('Failed to publish chapter transcoding completed event - channel buffer full');
         return false;
      } catch (error) {
         rabbitmqLogger.error({ err: error, chapterId: message.chapterId }, 'Error publishing chapter transcoding completed event');
         return false;
      }
   }

   /**
    * Consume transcoding jobs
    */
   public async consumeTranscodingJobs(
      queueName: string,
      callback: (jobData: TranscodingJobData, message: amqp.Message) => Promise<void>
   ): Promise<void> {
      if (!this.channel) {
         throw new Error('Channel not available');
      }

      const fullQueueName = `${config.RABBITMQ_QUEUE_PREFIX}.transcode.${queueName}`;

      try {
         await this.channel.consume(fullQueueName, async (message: amqp.Message | null) => {
            if (!message) {
               return;
            }

            try {
               const jobData: TranscodingJobData = JSON.parse(message.content.toString());
               rabbitmqLogger.info({ chapterId: jobData.chapter.id }, 'Processing transcoding job');

               await callback(jobData, message);

               // Acknowledge the message
               this.channel!.ack(message);
            } catch (error) {
               rabbitmqLogger.error({ err: error }, 'Error processing transcoding job');

               // Reject and requeue the message
               this.channel!.nack(message, false, true);
            }
         }, {
            noAck: false
         });

         rabbitmqLogger.info({ queueName: fullQueueName }, 'Started consuming transcoding jobs');
      } catch (error) {
         rabbitmqLogger.error({ err: error, queueName: fullQueueName }, 'Error setting up transcoding consumer');
         throw error;
      }
   }

   /**
    * Generic consume method for any queue
    * Consumes messages from a specified queue and processes them with a callback
    */
   public async consume<T>(
      queueName: string,
      callback: (data: T, message: amqp.Message) => Promise<void>
   ): Promise<void> {
      if (!this.channel) {
         throw new Error('Channel not available');
      }

      try {
         await this.channel.consume(queueName, async (message: amqp.Message | null) => {
            if (!message) {
               return;
            }

            try {
               const data: T = JSON.parse(message.content.toString());
               rabbitmqLogger.info({ queueName }, 'Processing message from queue');

               await callback(data, message);

               // Acknowledge the message after successful processing
               this.channel!.ack(message);
            } catch (error) {
               rabbitmqLogger.error({ err: error, queueName }, 'Error processing message from queue');

               // Reject and requeue the message on error
               this.channel!.nack(message, false, true);
            }
         }, {
            noAck: false
         });

         rabbitmqLogger.info({ queueName }, 'Started consuming messages from queue');
      } catch (error) {
         rabbitmqLogger.error({ err: error, queueName }, 'Error setting up consumer');
         throw error;
      }
   }

   /**
    * Get queue statistics
    */
   public async getQueueStats(): Promise<{
      [queueName: string]: {
         messageCount: number;
         consumerCount: number;
      };
   }> {
      if (!this.channel) {
         throw new Error('Channel not available');
      }

      const stats: any = {};
      const queues = ['priority', 'normal', 'low'];

      for (const queue of queues) {
         try {
            const queueInfo = await this.channel.checkQueue(`${config.RABBITMQ_QUEUE_PREFIX}.transcode.${queue}`);
            stats[queue] = {
               messageCount: queueInfo.messageCount,
               consumerCount: queueInfo.consumerCount
            };
         } catch (error) {
            rabbitmqLogger.error({ err: error, queue }, 'Error getting stats for queue');
            stats[queue] = {
               messageCount: 0,
               consumerCount: 0
            };
         }
      }

      return stats;
   }

   /**
    * Handle connection errors and implement reconnection logic
    */
   private async handleConnectionError(): Promise<void> {
      this.connection = null;
      this.channel = null;

      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
         rabbitmqLogger.error('Max reconnection attempts reached; stopping reconnection attempts');
         return;
      }

      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

      rabbitmqLogger.warn({
         delay,
         attempt: this.reconnectAttempts,
         maxAttempts: this.maxReconnectAttempts,
      }, 'Attempting to reconnect to RabbitMQ');

      setTimeout(async () => {
         try {
            await this.connect();
         } catch (error) {
            rabbitmqLogger.error({ err: error }, 'Reconnection attempt failed');
         }
      }, delay);
   }

   /**
    * Close connection gracefully
    */
   public async close(): Promise<void> {
      try {
         if (this.channel) {
            await this.channel.close();
            this.channel = null;
         }

         if (this.connection) {
            await (this.connection as any).close();
            this.connection = null;
         }

         rabbitmqLogger.info('RabbitMQ connection closed gracefully');
      } catch (error) {
         rabbitmqLogger.error({ err: error }, 'Error closing RabbitMQ connection');
      }
   }

   /**
    * Check if connected
    */
   public isConnected(): boolean {
      return this.connection !== null && this.channel !== null;
   }
}

/**
 * RabbitMQ connection factory
 */
export class RabbitMQFactory {
   private static connection = RabbitMQConnection.getInstance();

   /**
    * Get RabbitMQ connection instance
    */
   public static getConnection(): RabbitMQConnection {
      return this.connection;
   }

   /**
    * Initialize RabbitMQ connection
    */
   public static async initialize(): Promise<void> {
      await this.connection.connect();
   }

   /**
    * Close RabbitMQ connection
    */
   public static async shutdown(): Promise<void> {
      await this.connection.close();
   }
}
