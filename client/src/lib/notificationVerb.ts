import type { NotificationType } from '@/contract';

/**
 * The verb shown after an actor's name, for the notifications page and the
 * realtime toast alike. Exhaustive over `NotificationType`: a new type fails
 * typecheck here instead of toasting a bare name (the toast had no `echo`).
 */
export function notificationVerb(
  n: { type: NotificationType; comment?: unknown },
  t: (key: string) => string,
): string {
  switch (n.type) {
    case 'like':
      return n.comment ? t('notifications.likedComment') : t('notifications.likedPost');
    case 'comment':
      return t('notifications.commentedOn');
    case 'reply':
      return t('notifications.replied');
    case 'follow':
      return t('notifications.followed');
    case 'mention':
      return t('notifications.mentioned');
    case 'message':
      return t('notifications.messagedYou');
    case 'echo':
      return t('notifications.echoedPost');
    default: {
      const unreachable: never = n.type;
      return unreachable;
    }
  }
}
