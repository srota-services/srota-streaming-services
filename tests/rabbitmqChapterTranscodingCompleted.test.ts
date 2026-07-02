/**
 * RabbitMQ publishChapterTranscodingCompleted tests
 */

import { RabbitMQConnection } from '../src/config/rabbitmq';

describe('RabbitMQConnection.publishChapterTranscodingCompleted', () => {
   it('publishes to chapters exchange with chapter.transcoding.completed routing key', async () => {
      const publish = jest.fn().mockReturnValue(true);
      const connection = Object.create(RabbitMQConnection.prototype) as RabbitMQConnection;
      (connection as unknown as { channel: { publish: typeof publish } }).channel = { publish };

      const result = await connection.publishChapterTranscodingCompleted({
         chapterId: 'chapter-1',
         audiobookId: 'book-1',
         bitrates: [64, 128, 256],
         status: 'completed',
         timestamp: '2026-06-30T00:00:00.000Z',
      });

      expect(result).toBe(true);
      expect(publish).toHaveBeenCalledWith(
         'chapters',
         'chapter.transcoding.completed',
         expect.any(Buffer),
         expect.objectContaining({ persistent: true }),
      );
   });
});
