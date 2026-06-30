/**
 * Internationalization Messages
 * Message catalog with support for multiple locales
 */
import { logger } from '../config/logger';

export interface MessageParams {
   [key: string]: string | number | boolean;
}

export interface MessageCatalog {
      streaming: {
         status_retrieved: string;
         preloaded: string;
         analytics_retrieved: string;
         no_bitrates_available: string;
         preload_failed: string;
         retry_initiated: string;
      };
      validation: {
         invalid_bitrate: string;
         invalid_chapter_id: string;
         missing_parameters: string;
         invalid_request: string;
      };
   unauthorized: {
      not_authenticated: string;
      access_denied: string;
      invalid_token: string;
   };
   errors: {
      internal_server_error: string;
      chapter_not_found: string;
      transcoded_version_not_available: string;
      segment_not_found: string;
      storage_error: string;
      transcoding_error: string;
      subscription_required: string;
      subscription_tier_too_low_chapter: string;
      guest_streaming_not_allowed: string;
   };
   success: {
      operation_completed: string;
      file_uploaded: string;
      cache_updated: string;
   };
}

const messages: Record<string, MessageCatalog> = {
   en: {
      streaming: {
         status_retrieved: 'Streaming status retrieved successfully',
         preloaded: 'Chapter preloaded successfully',
         analytics_retrieved: 'Analytics retrieved successfully',
         no_bitrates_available: 'No transcoded bitrates available for this chapter',
         preload_failed: 'Failed to preload chapter segments',
         retry_initiated: 'Transcoding retry initiated successfully',
      },
      validation: {
         invalid_bitrate: 'Invalid bitrate value provided',
         invalid_chapter_id: 'Invalid chapter ID format',
         missing_parameters: 'Required parameters are missing',
         invalid_request: 'Invalid request parameters',
      },
      unauthorized: {
         not_authenticated: 'User not authenticated',
         access_denied: 'Access denied to this resource',
         invalid_token: 'Invalid authentication token'
      },
      errors: {
         internal_server_error: 'An internal server error occurred',
         chapter_not_found: 'Chapter not found or access denied',
         transcoded_version_not_available: 'Transcoded version not available for this bitrate',
         segment_not_found: 'Segment file not found',
         storage_error: 'Storage operation failed',
         transcoding_error: 'Transcoding operation failed',
         subscription_required: 'This audiobook requires an active subscription',
         subscription_tier_too_low_chapter: 'Your current subscription plan does not include access to this chapter.',
         guest_streaming_not_allowed: 'Please sign up or log in to play audiobooks',
      },
      success: {
         operation_completed: 'Operation completed successfully',
         file_uploaded: 'File uploaded successfully',
         cache_updated: 'Cache updated successfully'
      }
   }
};

/**
 * Get message with parameter substitution
 */
export function getMessage(
   locale: string,
   category: keyof MessageCatalog,
   key: string,
   params?: MessageParams
): string {
   const catalog = messages[locale] || messages.en;
   const categoryMessages = catalog[category];

   if (!categoryMessages || !(key in categoryMessages)) {
      logger.warn({ category, key, locale }, 'Message not found');
      return `${category}.${key}`;
   }

   let message = (categoryMessages as any)[key];

   // Replace parameters in message
   if (params) {
      Object.entries(params).forEach(([paramKey, paramValue]) => {
         const placeholder = `{{${paramKey}}}`;
         message = message.replace(new RegExp(placeholder, 'g'), String(paramValue));
      });
   }

   return message;
}

/**
 * Get success message
 */
export function getSuccessMessage(key: string, params?: MessageParams, locale: string = 'en'): string {
   return getMessage(locale, 'success', key, params);
}

/**
 * Get error message
 */
export function getErrorMessage(key: string, params?: MessageParams, locale: string = 'en'): string {
   return getMessage(locale, 'errors', key, params);
}

/**
 * Get validation message
 */
export function getValidationMessage(key: string, params?: MessageParams, locale: string = 'en'): string {
   return getMessage(locale, 'validation', key, params);
}

/**
 * Get unauthorized message
 */
export function getUnauthorizedMessage(key: string, params?: MessageParams, locale: string = 'en'): string {
   return getMessage(locale, 'unauthorized', key, params);
}

/**
 * Get streaming message
 */
export function getStreamingMessage(key: string, params?: MessageParams, locale: string = 'en'): string {
   return getMessage(locale, 'streaming', key, params);
}

/**
 * Check if locale is supported
 */
export function isLocaleSupported(locale: string): boolean {
   return locale in messages;
}

/**
 * Get supported locales
 */
export function getSupportedLocales(): string[] {
   return Object.keys(messages);
}

/**
 * Set default locale (for future use)
 */
let defaultLocale = 'en';

export function setDefaultLocale(locale: string): void {
   if (isLocaleSupported(locale)) {
      defaultLocale = locale;
   } else {
      logger.warn({ locale, defaultLocale }, 'Locale is not supported, using default locale');
   }
}

export function getDefaultLocale(): string {
   return defaultLocale;
}
