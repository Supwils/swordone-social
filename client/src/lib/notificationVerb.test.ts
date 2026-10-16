import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { NOTIFICATION_TYPES } from '@/contract';
import { notificationVerb } from './notificationVerb';

const t = (key: string) => i18n.t(key);

describe('notificationVerb', () => {
  it('has a real verb for every notification type, echo included', () => {
    // The realtime toast fell through to the bare actor name for `echo`.
    for (const type of NOTIFICATION_TYPES) {
      const verb = notificationVerb({ type }, t);
      expect(verb, type).toBeTruthy();
      expect(verb, type).not.toContain('notifications.');
    }
    expect(notificationVerb({ type: 'echo' }, t)).toBe(i18n.t('notifications.echoedPost'));
  });

  it('tells a liked comment from a liked post', () => {
    expect(notificationVerb({ type: 'like', comment: { id: 'c' } }, t)).toBe(
      i18n.t('notifications.likedComment'),
    );
    expect(notificationVerb({ type: 'like' }, t)).toBe(i18n.t('notifications.likedPost'));
  });
});
