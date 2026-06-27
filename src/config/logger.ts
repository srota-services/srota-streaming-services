/**
 * Pino Logger Configuration
 * File-only structured logging per component.
 * All error-level logs are mirrored to error.log.
 */
import pino, { Logger, LoggerOptions } from 'pino';
import path from 'path';
import fs from 'fs';
import { config } from './env';

interface ServiceLoggers {
   logger: Logger;
   errorLogger: Logger;
   apiAccessLogger: Logger;
   redisLogger: Logger;
   bullLogger: Logger;
   rabbitmqLogger: Logger;
}

function createLoggers(): ServiceLoggers {
   if (config.NODE_ENV === 'test') {
      const silent = pino({ level: 'silent' });
      return {
         logger: silent,
         errorLogger: silent,
         apiAccessLogger: silent,
         redisLogger: silent,
         bullLogger: silent,
         rabbitmqLogger: silent,
      };
   }

   const logDir = path.resolve(process.cwd(), config.LOG_DIR);
   if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
   }

   const baseLoggerConfig: pino.LoggerOptions = {
      level: config.LOG_LEVEL,
      formatters: {
         level: (label: string) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
   };

   function createFileDestination(filename: string) {
      const fd = fs.openSync(path.join(logDir, filename), 'a');
      return pino.destination({ fd, minLength: 0, sync: false });
   }

   const errorLogFile = createFileDestination('error.log');

   function createMirroredLogger(filename: string, component?: string): Logger {
      const fileDest = createFileDestination(filename);
      const options: LoggerOptions = component
         ? { ...baseLoggerConfig, base: { component } }
         : baseLoggerConfig;

      return pino(
         options,
         pino.multistream([
            { stream: fileDest },
            { level: 'error', stream: errorLogFile },
         ]),
      );
   }

   const errorLogger = pino(
      { ...baseLoggerConfig, level: 'error' },
      errorLogFile,
   );

   return {
      logger: createMirroredLogger('app.log'),
      errorLogger,
      apiAccessLogger: createMirroredLogger('api-access.log', 'api-access'),
      redisLogger: createMirroredLogger('redis.log', 'redis'),
      bullLogger: createMirroredLogger('bull.log', 'bull'),
      rabbitmqLogger: createMirroredLogger('rabbitmq.log', 'rabbitmq'),
   };
}

const loggers = createLoggers();

export const logger = loggers.logger;
export const errorLogger = loggers.errorLogger;
export const apiAccessLogger = loggers.apiAccessLogger;
export const redisLogger = loggers.redisLogger;
export const bullLogger = loggers.bullLogger;
export const rabbitmqLogger = loggers.rabbitmqLogger;
export default logger;
