import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

/**
 * Error handling utilities
 */
export class ErrorHandler {
   /**
    * Handle 404 Not Found errors
    */
   static handleNotFound = (req: Request, res: Response): void => {
      res.status(404).json({
         error: 'Not Found',
         message: `Route ${req.method} ${req.originalUrl} not found`,
         timestamp: new Date().toISOString()
      });
   };

   /**
    * Global error handler
    */
   static handleError = (err: Error, req: Request, res: Response, _next: NextFunction): void => {
      (res.locals as { apiError?: Error }).apiError = err;

      let statusCode = 500;
      let message = 'Internal Server Error';

      if (err.name === 'ValidationError') {
         statusCode = 400;
         message = 'Validation Error';
      } else if (err.name === 'UnauthorizedError') {
         statusCode = 401;
         message = 'Unauthorized';
      } else if (err.name === 'ForbiddenError') {
         statusCode = 403;
         message = 'Forbidden';
      } else if (err.name === 'NotFoundError') {
         statusCode = 404;
         message = 'Not Found';
      }

      const errorContext = {
         err,
         method: req.method,
         url: req.originalUrl,
         statusCode,
      };

      if (statusCode < 500) {
         logger.warn(errorContext, 'Client error');
      } else {
         logger.error(errorContext, 'Server error');
      }

      const errorResponse = {
         error: message,
         timestamp: new Date().toISOString(),
         path: req.originalUrl,
         method: req.method
      };

      if (process.env.NODE_ENV === 'development') {
         (errorResponse as Record<string, unknown>).details = err.message;
         (errorResponse as Record<string, unknown>).stack = err.stack;
      }

      res.status(statusCode).json(errorResponse);
   };

   /**
    * Create custom error
    */
   static createError = (message: string, statusCode: number = 500, name?: string): Error => {
      const error = new Error(message);
      error.name = name || 'CustomError';
      (error as Error & { statusCode: number }).statusCode = statusCode;
      return error;
   };

   /**
    * Handle async errors
    */
   static asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void) => {
      return (req: Request, res: Response, next: NextFunction) => {
         Promise.resolve(fn(req, res, next)).catch(next);
      };
   };
}
