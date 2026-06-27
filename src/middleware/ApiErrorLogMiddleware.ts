/**
 * Logs API error responses (4xx/5xx) to error.log when the response finishes.
 */
import { Request, Response, NextFunction } from 'express';
import { errorLogger } from '../config/logger';

export function apiErrorLogMiddleware(req: Request, res: Response, next: NextFunction): void {
   res.on('finish', () => {
      if (res.statusCode < 400) {
         return;
      }

      const apiError = (res.locals as { apiError?: unknown }).apiError;

      errorLogger.error(
         {
            category: 'api',
            method: req.method,
            url: req.originalUrl,
            statusCode: res.statusCode,
            ...(apiError !== undefined ? { err: apiError } : {}),
         },
         'API error response',
      );
   });

   next();
}
