import { Response } from 'express';
import { createStreamAccessMiddleware } from '../../src/middleware/StreamAccessMiddleware';
import { AuthRole } from '../../src/constants/authRoles';
import { AuthenticatedRequest } from '../../src/types/auth';

jest.mock('../../src/utils/MessageHandler', () => ({
   MessageHandler: {
      getErrorMessage: (key: string) => key,
      getUnauthorizedMessage: (key: string) => key,
   },
}));

jest.mock('../../src/utils/ResponseHandler', () => ({
   ResponseHandler: {
      notFound: jest.fn(),
      forbidden: jest.fn(),
      unauthorized: jest.fn(),
      serverError: jest.fn(),
   },
}));

jest.mock('../../src/config/logger', () => ({
   logger: {
      error: jest.fn(),
   },
}));

import { ResponseHandler } from '../../src/utils/ResponseHandler';

function buildMockResponse(): Response {
   return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      req: { originalUrl: '/test', method: 'GET' },
   } as unknown as Response;
}

describe('StreamAccessMiddleware', () => {
   const next = jest.fn();
   const mockChapterGating = {
      getChapterStreamGating: jest.fn(),
   };
   const mockAccessService = {
      evaluateListenerStreamAccess: jest.fn(),
   };

   const { requireChapterStreamAccess } = createStreamAccessMiddleware(
      mockChapterGating as any,
      mockAccessService as any,
   );

   beforeEach(() => {
      jest.clearAllMocks();
   });

   test('blocks GUEST from streaming', async () => {
      const req = {
         params: { chapterId: 'chapter-1' },
         headers: { authorization: 'Bearer guest-token' },
         user: { id: 'guest-1', role: AuthRole.GUEST },
      } as unknown as AuthenticatedRequest;
      const res = buildMockResponse();

      await requireChapterStreamAccess()(req, res, next);

      expect(ResponseHandler.forbidden).toHaveBeenCalledWith(res, 'guest_streaming_not_allowed');
      expect(mockChapterGating.getChapterStreamGating).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
   });

   test('allows AUTHOR to bypass subscription gating', async () => {
      const req = {
         params: { chapterId: 'chapter-1' },
         headers: { authorization: 'Bearer author-token' },
         user: { id: 'author-1', role: AuthRole.AUTHOR },
      } as unknown as AuthenticatedRequest;
      const res = buildMockResponse();

      await requireChapterStreamAccess()(req, res, next);

      expect(mockChapterGating.getChapterStreamGating).not.toHaveBeenCalled();
      expect(mockAccessService.evaluateListenerStreamAccess).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
   });

   test('allows LISTENER on free chapter', async () => {
      mockChapterGating.getChapterStreamGating.mockResolvedValue({
         chapterId: 'chapter-1',
         requiredTier: null,
      });
      mockAccessService.evaluateListenerStreamAccess.mockResolvedValue({ canAccess: true });

      const req = {
         params: { chapterId: 'chapter-1' },
         headers: { authorization: 'Bearer listener-token' },
         user: { id: 'listener-1', role: AuthRole.LISTENER },
      } as unknown as AuthenticatedRequest;
      const res = buildMockResponse();

      await requireChapterStreamAccess()(req, res, next);

      expect(mockChapterGating.getChapterStreamGating).toHaveBeenCalledWith('chapter-1', 'listener-token');
      expect(mockAccessService.evaluateListenerStreamAccess).toHaveBeenCalledWith(
         null,
         'listener-1',
         'listener-token',
         AuthRole.LISTENER,
      );
      expect(next).toHaveBeenCalled();
   });

   test('blocks LISTENER when subscription tier is too low', async () => {
      mockChapterGating.getChapterStreamGating.mockResolvedValue({
         chapterId: 'chapter-1',
         requiredTier: 'PREMIUM',
      });
      mockAccessService.evaluateListenerStreamAccess.mockResolvedValue({
         canAccess: false,
         message: 'subscription_tier_too_low_chapter',
      });

      const req = {
         params: { chapterId: 'chapter-1' },
         headers: { authorization: 'Bearer listener-token' },
         user: { id: 'listener-1', role: AuthRole.LISTENER },
      } as unknown as AuthenticatedRequest;
      const res = buildMockResponse();

      await requireChapterStreamAccess()(req, res, next);

      expect(ResponseHandler.forbidden).toHaveBeenCalledWith(res, 'subscription_tier_too_low_chapter');
      expect(next).not.toHaveBeenCalled();
   });

   test('allows LISTENER with sufficient subscription tier', async () => {
      mockChapterGating.getChapterStreamGating.mockResolvedValue({
         chapterId: 'chapter-1',
         requiredTier: 'STANDARD',
      });
      mockAccessService.evaluateListenerStreamAccess.mockResolvedValue({
         canAccess: true,
         requiredTier: 'STANDARD',
         userTier: 'PREMIUM',
      });

      const req = {
         params: { chapterId: 'chapter-1' },
         headers: { authorization: 'Bearer listener-token' },
         user: { id: 'listener-1', role: AuthRole.LISTENER },
      } as unknown as AuthenticatedRequest;
      const res = buildMockResponse();

      await requireChapterStreamAccess()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(ResponseHandler.forbidden).not.toHaveBeenCalled();
   });
});
