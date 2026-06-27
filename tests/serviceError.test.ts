jest.mock('../src/config/logger', () => ({
   errorLogger: {
      error: jest.fn(),
   },
}));

import { Prisma } from '@prisma/client';
import { HttpStatusError, rethrowServiceError, logServiceError } from '../src/utils/serviceError';
import { errorLogger } from '../src/config/logger';

describe('streaming rethrowServiceError', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('rethrows HttpStatusError unchanged', () => {
      const err = new HttpStatusError('bad request', 400, 'ValidationError');
      expect(() => rethrowServiceError(err, { operation: 'validate' })).toThrow(err);
   });

   it('maps Prisma P2002 to conflict HttpStatusError and logs error', () => {
      const prismaErr = new Prisma.PrismaClientKnownRequestError('duplicate', {
         code: 'P2002',
         clientVersion: '5.0.0',
      });

      expect(() => rethrowServiceError(prismaErr, { operation: 'saveBitrate' })).toThrow(HttpStatusError);
      try {
         rethrowServiceError(prismaErr, { operation: 'saveBitrate' });
      } catch (e) {
         expect((e as HttpStatusError).statusCode).toBe(409);
      }

      expect(errorLogger.error).toHaveBeenCalledWith(
         expect.objectContaining({ prismaCode: 'P2002', operation: 'saveBitrate' }),
         'Database error',
      );
   });

   it('logs unknown errors before throwing internal 500', () => {
      const err = new Error('worker failed');
      expect(() => rethrowServiceError(err, { operation: 'deleteChapter' })).toThrow(HttpStatusError);
      expect(errorLogger.error).toHaveBeenCalledWith(
         expect.objectContaining({ err, operation: 'deleteChapter' }),
         'Unhandled service error',
      );
   });
});

describe('streaming logServiceError', () => {
   it('logs validation errors with context', () => {
      const err = new Prisma.PrismaClientValidationError('invalid', { clientVersion: '5.0.0' });
      logServiceError(err, { operation: 'upsertJob' });
      expect(errorLogger.error).toHaveBeenCalledWith(
         expect.objectContaining({ operation: 'upsertJob' }),
         'Database validation error',
      );
   });
});
