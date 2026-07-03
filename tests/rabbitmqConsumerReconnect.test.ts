/**
 * RabbitMQ consumer re-registration after reconnect
 */

import { RabbitMQConnection } from '../src/config/rabbitmq';

jest.mock('../src/config/logger', () => ({
   rabbitmqLogger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

describe('RabbitMQConnection consumer reconnect', () => {
   it('re-registers stored consumers when restoreAllConsumers runs', async () => {
      const connection = Object.create(RabbitMQConnection.prototype) as RabbitMQConnection;
      const setup = jest.fn().mockResolvedValue(undefined);

      (connection as unknown as { consumerSetups: Map<string, () => Promise<void>> }).consumerSetups =
         new Map([['transcode.normal', setup]]);

      await (connection as unknown as { restoreAllConsumers: () => Promise<void> }).restoreAllConsumers();

      expect(setup).toHaveBeenCalledTimes(1);
   });
});
