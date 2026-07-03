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
   private reconnectDelay = 5000; // 5 seconds
   private maxReconnectDelay = 60_000;
   private reconnectScheduled = false;
   /** Consumer setup functions re-invoked after every reconnect. */
   private readonly consumerSetups = new Map<string, () => Promise<void>>();

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
         this.connection = await amqp.connect(config.RABBITMQ_URL, {
            heartbeat: 30,
         }) as unknown as amqp.Connection;

         this.connection!.on('error', (error: Error) => {
            rabbitmqLogger.error({ err: error }, 'RabbitMQ connection error');
            this.scheduleReconnect();
         });

         this.connection!.on('close', () => {
            rabbitmqLogger.warn('RabbitMQ connection closed');
            this.scheduleReconnect();
         });

         this.channel = await (this.connection as any).createChannel();

         this.channel!.on('error', (error: Error) => {
            rabbitmqLogger.error({ err: error }, 'RabbitMQ channel error');
            this.scheduleReconnect();
         });

         this.channel!.on('close', () => {
            rabbitmqLogger.warn('RabbitMQ channel closed');
            this.channel = null;
            this.scheduleReconnect();
         });

         // Set prefetch to prevent overwhelming workers
         await this.channel!.prefetch(1);

         rabbitmqLogger.info('Connected to RabbitMQ successfully');
         this.reconnectAttempts = 0;
         this.isConnecting = false;

         // Setup exchanges and queues, then restore all registered consumers
         await this.setupExchangesAndQueues();
         await this.restoreAllConsumers();

      } catch (error) {
         rabbitmqLogger.error({ err: error }, 'Failed to connect to RabbitMQ');
         this.isConnecting = false;
         this.clearConnectionState();
         this.scheduleReconnect();
         throw error;
      }
   }

   /**
    * Register a consumer and start it when the channel is available.
    * The setup function is stored and re-run automatically after reconnect.
    */
   private async registerConsumer(consumerId: string, setup: () => Promise<void>): Promise<void> {
      this.consumerSetups.set(consumerId, setup);
      if (this.channel) {
         await setup();
      }
   }

   /**
    * Re-subscribe all registered consumers (after reconnect or channel recovery).
    */
   private async restoreAllConsumers(): Promise<void> {
      if (this.consumerSetups.size === 0) {
         return;
      }

      rabbitmqLogger.info(
         { consumerCount: this.consumerSetups.size },
         'Restoring RabbitMQ consumers after reconnect',
      );

      for (const [consumerId, setup] of this.consumerSetups) {
         try {
            await setup();
            rabbitmqLogger.info({ consumerId }, 'Restored RabbitMQ consumer');
         } catch (error) {
            rabbitmqLogger.error({ err: error, consumerId }, 'Failed to restore RabbitMQ consumer');
         }
      }
   }

   private clearConnectionState(): void {
      this.connection = null;
      this.channel = null;
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
      const fullQueueName = `${config.RABBITMQ_QUEUE_PREFIX}.transcode.${queueName}`;
      const consumerId = `transcode.${queueName}`;

      await this.registerConsumer(consumerId, async () => {
         if (!this.channel) {
            throw new Error('Channel not available');
         }

         await this.channel.consume(fullQueueName, async (message: amqp.Message | null) => {
            if (!message) {
               return;
            }

            try {
               const jobData: TranscodingJobData = JSON.parse(message.content.toString());
               rabbitmqLogger.info({ chapterId: jobData.chapter.id }, 'Processing transcoding job');

               await callback(jobData, message);

               this.channel!.ack(message);
            } catch (error) {
               rabbitmqLogger.error({ err: error }, 'Error processing transcoding job');
               this.channel!.nack(message, false, true);
            }
         }, {
            noAck: false,
         });

         rabbitmqLogger.info({ queueName: fullQueueName }, 'Started consuming transcoding jobs');
      });
   }

   /**
    * Generic consume method for any queue
    * Consumes messages from a specified queue and processes them with a callback
    */
   public async consume<T>(
      queueName: string,
      callback: (data: T, message: amqp.Message) => Promise<void>
   ): Promise<void> {
      const consumerId = `generic.${queueName}`;

      await this.registerConsumer(consumerId, async () => {
         if (!this.channel) {
            throw new Error('Channel not available');
         }

         await this.channel.consume(queueName, async (message: amqp.Message | null) => {
            if (!message) {
               return;
            }

            try {
               const data: T = JSON.parse(message.content.toString());
               rabbitmqLogger.info({ queueName }, 'Processing message from queue');

               await callback(data, message);

               this.channel!.ack(message);
            } catch (error) {
               rabbitmqLogger.error({ err: error, queueName }, 'Error processing message from queue');
               this.channel!.nack(message, false, true);
            }
         }, {
            noAck: false,
         });

         rabbitmqLogger.info({ queueName }, 'Started consuming messages from queue');
      });
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
    * Schedule a reconnect with exponential backoff (retries indefinitely for worker uptime).
    */
   private scheduleReconnect(): void {
      if (this.reconnectScheduled || this.isConnecting) {
         return;
      }

      const staleConnection = this.connection;
      const staleChannel = this.channel;
      this.clearConnectionState();

      void staleChannel?.close().catch(() => undefined);
      void (staleConnection as { close?: () => Promise<void> } | null)?.close?.().catch(() => undefined);

      this.reconnectScheduled = true;
      this.reconnectAttempts++;

      const delay = Math.min(
         this.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)),
         this.maxReconnectDelay,
      );

      rabbitmqLogger.warn({
         delay,
         attempt: this.reconnectAttempts,
      }, 'Scheduling RabbitMQ reconnect');

      setTimeout(async () => {
         this.reconnectScheduled = false;

         try {
            await this.connect();
         } catch (error) {
            rabbitmqLogger.error({ err: error }, 'RabbitMQ reconnection attempt failed');
         }
      }, delay);
   }

   /**
    * Close connection gracefully
    */
   public async close(): Promise<void> {
      try {
         this.consumerSetups.clear();
         this.reconnectScheduled = false;

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
