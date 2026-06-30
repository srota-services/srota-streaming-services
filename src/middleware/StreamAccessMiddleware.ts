import { Request, Response, NextFunction } from 'express';
import {
   ChapterGatingClient,
   ChapterNotFoundError,
   chapterGatingClient,
} from '../clients/ChapterGatingClient';
import { SubscriptionAccessService, subscriptionAccessService } from '../services/SubscriptionAccessService';
import { ResponseHandler } from '../utils/ResponseHandler';
import { MessageHandler } from '../utils/MessageHandler';
import { AuthenticatedRequest } from '../types/auth';
import { isGuestRole, isListenerRole } from '../constants/authRoles';
import { logger } from '../config/logger';

function extractBearerToken(req: Request): string | null {
   const authHeader = req.headers.authorization;
   if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      return token.length > 0 ? token : null;
   }

   const queryToken = req.query['access_token'];
   if (typeof queryToken === 'string' && queryToken.trim().length > 0) {
      return queryToken.trim();
   }

   return null;
}

async function evaluateChapterStreamAccess(
   req: Request,
   chapterId: string,
   chapterGating: ChapterGatingClient,
   accessService: SubscriptionAccessService,
): Promise<{ allowed: true } | { allowed: false; statusCode: number; message: string }> {
   const authReq = req as AuthenticatedRequest;
   const userRole = authReq.user?.role;

   if (isGuestRole(userRole)) {
      return {
         allowed: false,
         statusCode: 403,
         message: MessageHandler.getErrorMessage('guest_streaming_not_allowed'),
      };
   }

   if (!isListenerRole(userRole)) {
      return { allowed: true };
   }

   const accessToken = extractBearerToken(req);
   const userId = authReq.user?.id;
   if (!userId || !accessToken) {
      return {
         allowed: false,
         statusCode: 401,
         message: MessageHandler.getUnauthorizedMessage('not_authenticated'),
      };
   }

   let requiredTier;
   try {
      const gating = await chapterGating.getChapterStreamGating(chapterId, accessToken);
      requiredTier = gating.requiredTier;
   } catch (error) {
      if (error instanceof ChapterNotFoundError) {
         return {
            allowed: false,
            statusCode: 404,
            message: MessageHandler.getErrorMessage('chapter_not_found'),
         };
      }
      throw error;
   }

   const access = await accessService.evaluateListenerStreamAccess(
      requiredTier,
      userId,
      accessToken,
      userRole,
   );

   if (!access.canAccess) {
      return {
         allowed: false,
         statusCode: 403,
         message: access.message ?? MessageHandler.getErrorMessage('subscription_required'),
      };
   }

   return { allowed: true };
}

function denyAccess(res: Response, statusCode: number, message: string): void {
   if (statusCode === 401) {
      ResponseHandler.unauthorized(res, message);
      return;
   }
   if (statusCode === 404) {
      ResponseHandler.notFound(res, message);
      return;
   }
   ResponseHandler.forbidden(res, message);
}

export function createStreamAccessMiddleware(
   chapterGating: ChapterGatingClient = chapterGatingClient,
   accessService: SubscriptionAccessService = subscriptionAccessService,
) {
   const checkChapterAccess = async (
      req: Request,
      res: Response,
      chapterId: string,
   ): Promise<boolean> => {
      try {
         const result = await evaluateChapterStreamAccess(req, chapterId, chapterGating, accessService);
         if (!result.allowed) {
            denyAccess(res, result.statusCode, result.message);
            return false;
         }
         return true;
      } catch (error) {
         logger.error({ err: error, chapterId }, 'Stream subscription access check failed');
         ResponseHandler.serverError(res, MessageHandler.getErrorMessage('internal_server_error'));
         return false;
      }
   };

   const requireChapterStreamAccess = () => {
      return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
         const chapterId = req.params['chapterId'];
         if (!chapterId) {
            next();
            return;
         }

         const allowed = await checkChapterAccess(req, res, chapterId);
         if (allowed) {
            next();
         }
      };
   };

   const requireQueryChapterStreamAccess = () => {
      return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
         const chapterId = req.query['chapterId'];
         if (typeof chapterId !== 'string' || chapterId.trim().length === 0) {
            next();
            return;
         }

         const allowed = await checkChapterAccess(req, res, chapterId.trim());
         if (allowed) {
            next();
         }
      };
   };

   const requireMultiplexChapterStreamAccess = () => {
      return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
         const rawChapterIds = req.query['chapterIds'];
         if (typeof rawChapterIds !== 'string' || rawChapterIds.trim().length === 0) {
            next();
            return;
         }

         const chapterIds = rawChapterIds
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0);

         for (const chapterId of chapterIds) {
            const allowed = await checkChapterAccess(req, res, chapterId);
            if (!allowed) {
               return;
            }
         }

         next();
      };
   };

   return {
      requireChapterStreamAccess,
      requireQueryChapterStreamAccess,
      requireMultiplexChapterStreamAccess,
   };
}

const defaultMiddleware = createStreamAccessMiddleware();

export const requireChapterStreamAccess = defaultMiddleware.requireChapterStreamAccess;
export const requireQueryChapterStreamAccess = defaultMiddleware.requireQueryChapterStreamAccess;
export const requireMultiplexChapterStreamAccess = defaultMiddleware.requireMultiplexChapterStreamAccess;
