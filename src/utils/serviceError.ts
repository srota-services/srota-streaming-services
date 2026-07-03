import { Prisma } from '@prisma/client';
import { errorLogger } from '../config/logger';

export interface ServiceErrorContext extends Record<string, unknown> {
   operation?: string;
}

const GENERIC_INTERNAL_MESSAGE = 'Internal Server Error';

export class HttpStatusError extends Error {
   readonly statusCode: number;

   constructor(message: string, statusCode: number, name: string) {
      super(message);
      this.name = name;
      this.statusCode = statusCode;
   }
}

function isHttpStatusError(error: unknown): error is HttpStatusError {
   return error instanceof HttpStatusError;
}

function isPrismaKnownError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
   return error instanceof Prisma.PrismaClientKnownRequestError;
}

function isPrismaValidationError(error: unknown): error is Prisma.PrismaClientValidationError {
   return error instanceof Prisma.PrismaClientValidationError;
}

export function logServiceError(error: unknown, context: ServiceErrorContext = {}): void {
   const base = { ...context, err: error };

   if (isPrismaKnownError(error)) {
      errorLogger.error(
         {
            ...base,
            prismaCode: error.code,
            prismaMeta: error.meta,
            clientVersion: error.clientVersion,
         },
         'Database error',
      );
      return;
   }

   if (isPrismaValidationError(error)) {
      errorLogger.error(
         {
            ...base,
            prismaClientVersion: error.clientVersion,
         },
         'Database validation error',
      );
      return;
   }

   errorLogger.error(base, 'Unhandled service error');
}

function mapPrismaError(error: Prisma.PrismaClientKnownRequestError): HttpStatusError {
   switch (error.code) {
      case 'P2002':
         return new HttpStatusError('Resource already exists', 409, 'ConflictError');
      case 'P2025':
         return new HttpStatusError('Resource not found', 404, 'NotFoundError');
      default:
         return new HttpStatusError(GENERIC_INTERNAL_MESSAGE, 500, 'InternalError');
   }
}

export function rethrowServiceError(
   error: unknown,
   context: ServiceErrorContext = {},
   internalMessage: string = GENERIC_INTERNAL_MESSAGE,
): never {
   if (isHttpStatusError(error)) {
      throw error;
   }

   if (error instanceof Error && ['ValidationError', 'UnauthorizedError', 'ForbiddenError', 'NotFoundError'].includes(error.name)) {
      throw error;
   }

   if (isPrismaKnownError(error)) {
      logServiceError(error, context);
      throw mapPrismaError(error);
   }

   logServiceError(error, context);
   throw new HttpStatusError(internalMessage, 500, 'InternalError');
}
