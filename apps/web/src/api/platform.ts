/**
 * ONE · API client — Shared
 *
 * Notification feed and Help & FAQ articles.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { requestJson } from './http.js';

export interface UserNotificationDto {
  readonly id: string;
  readonly kind: 'EXAM_ASSIGNED' | 'EXAM_REOPENED' | 'RESULT_PUBLISHED' | 'SYSTEM' | 'ANNOUNCEMENT';
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export function listMyNotifications(token: string, signal?: AbortSignal): Promise<{ notifications: UserNotificationDto[]; unreadCount: number }> {
  return requestJson('/api/v1/me/notifications', { token, ...(signal ? { signal } : {}) });
}

export function markAllNotificationsRead(token: string): Promise<{ marked: number }> {
  return requestJson('/api/v1/me/notifications/read-all', { token, method: 'POST' });
}

// --- DPDP consent -----------------------------------------------------------

export interface HelpArticleDto {
  readonly id: string;
  readonly personas: readonly string[];
  readonly title: string;
  readonly keywords: readonly string[];
  readonly body: string;
}

export function getHelpArticles(signal?: AbortSignal): Promise<{ readonly articles: readonly HelpArticleDto[] }> {
  return requestJson('/api/v1/help', signal ? { signal } : {});
}
