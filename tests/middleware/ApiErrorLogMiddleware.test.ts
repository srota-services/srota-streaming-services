jest.mock('../../src/config/logger', () => ({
   errorLogger: {
      error: jest.fn(),
   },
}));

import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { errorLogger } from '../../src/config/logger';
import { apiErrorLogMiddleware } from '../../src/middleware/ApiErrorLogMiddleware';

function createMockResponse(statusCode: number, locals: Record<string, unknown> = {}): Response {
   const emitter = new EventEmitter();
   const res = emitter as Response & EventEmitter;
   res.statusCode = statusCode;
   res.locals = locals;
   return res;
}

describe('apiErrorLogMiddleware', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('does not log successful responses', () => {
      const req = { method: 'GET', originalUrl: '/api/stream/health' } as Request;
      const res = createMockResponse(200);
      const next = jest.fn();

      apiErrorLogMiddleware(req, res, next);
      res.emit('finish');

      expect(next).toHaveBeenCalled();
      expect(errorLogger.error).not.toHaveBeenCalled();
   });

   it('logs 404 API error responses', () => {
      const req = { method: 'GET', originalUrl: '/api/missing' } as Request;
      const res = createMockResponse(404);
      const next = jest.fn();

      apiErrorLogMiddleware(req, res, next);
      res.emit('finish');

      expect(errorLogger.error).toHaveBeenCalledWith(
         expect.objectContaining({
            category: 'api',
            method: 'GET',
            url: '/api/missing',
            statusCode: 404,
         }),
         'API error response',
      );
   });

   it('logs 500 API error responses with attached error', () => {
      const err = new Error('Transcoding failed');
      const req = { method: 'GET', originalUrl: '/api/v1/stream/chapters/1/status' } as Request;
      const res = createMockResponse(500, { apiError: err });
      const next = jest.fn();

      apiErrorLogMiddleware(req, res, next);
      res.emit('finish');

      expect(errorLogger.error).toHaveBeenCalledWith(
         expect.objectContaining({
            category: 'api',
            method: 'GET',
            url: '/api/v1/stream/chapters/1/status',
            statusCode: 500,
            err,
         }),
         'API error response',
      );
   });
});
