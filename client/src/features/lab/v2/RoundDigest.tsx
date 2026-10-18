/**
 * `RoundDigest` — one round in plain terms (lab v2 §6): outcomes per arm,
 * highlights, conversations, interactions, who dreamed (with the 最近 diff
 * when the dream filed one) and which new words spread. Every number comes
 * from `GET /agents/rounds/:roundId`, computed from stored rows; nothing here
 * is model-written.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card } from '@/components/primitives';
import type { RoundDigestDTO } from '@/features/lab/types';
import { ArmName } from '@/features/lab/metrics/ArmName';
import { ARM_IDS } from '@/features/lab/metrics/armColors';
import { fmtNum } from '@/features/lab/metrics/format';
import s from './v2.module.css';

type PostRef = RoundDigestDTO['highlights']['mostInCharacter'][number];
type RecentDiff = NonNullable<RoundDigestDTO['changes']['dreams'][number]['recent']>;

const userPath = (username: string) => `/u/${encodeURIComponent(username)}`;
const postPath = (postId: string) => `/p/${encodeURIComponent(postId)}`;

/**
 * A dream's 最近 change as plain text: the list as written (kept items plain,
 * new ones marked `+`), then the items it dropped, struck through.
 */
function RecentChange({ recent, label }: { recent: RecentDiff; label: string }) {
  const before = new Set(recent.before);
  const after = new Set(recent.after);
  const removed = recent.before.filter((item) => !after.has(item));
  return (
    <ul className={s.recentDiff} aria-label={label}>
      {recent.after.map((item, i) => (
        <li key={`a${i}`}>{before.has(item) ? item : `+ ${item}`}</li>
      ))}
      {removed.map((item, i) => (
        <li key={`r${i}`}>
          <del>{item}</del>
        </li>
      ))}
    </ul>
  );
}

export function RoundDigest({ digest }: { digest: RoundDigestDTO }) {
  const { t } = useTranslation();
  const postById = new Map(digest.posts.map((p) => [p.postId, p]));
  const { highlights, interactions, changes } = digest;

  const postLink = (ref: PostRef) => {
    const p = postById.get(ref.postId);
    return (
      <span className={s.postRef}>
        <Link to={userPath(ref.username)}>@{ref.username}</Link>{' '}
        <Link to={postPath(ref.postId)}>{p?.excerpt || ref.postId}</Link>
        {p && p.cardSim !== null && <span className={s.num}> {fmtNum(p.cardSim)}</span>}
      </span>
    );
  };

  const block = (title: string, testId: string, items: ReactNode[]) => (
    <div className={s.block} data-testid={testId}>
      <h3 className={s.blockTitle}>{title}</h3>
      {items.length === 0 ? (
        <p className={s.note}>{t('lab.v2.digest.none')}</p>
      ) : (
        <ol className={s.list}>{items}</ol>
      )}
    </div>
  );

  return (
    <Card as="section" className={s.digest}>
      <h2 className={s.sectionTitle}>
        {digest.round.ordinal !== null
          ? t('lab.v2.digest.title', {
              ordinal: digest.round.ordinal,
              roundId: digest.round.roundId,
            })
          : t('lab.v2.digest.titleUnnumbered', { roundId: digest.round.roundId })}
      </h2>

      <div className={s.outcomes}>
        {ARM_IDS.map((arm) => {
          const o = digest.outcomes[arm];
          return (
            <div key={arm} className={s.outcome} data-testid={`outcome-${arm}`}>
              <span>
                <ArmName arm={arm} />
              </span>
              <span>{t('lab.v2.digest.cards', { count: o.cards })}</span>
              <span>{t('lab.v2.digest.landed', { landed: o.landed, count: o.attempted })}</span>
              {o.failures > 0 && (
                <span className={s.warn}>{t('lab.v2.digest.failures', { n: o.failures })}</span>
              )}
              {o.missing > 0 && (
                <span className={s.warn}>{t('lab.v2.digest.missing', { n: o.missing })}</span>
              )}
              {o.dreams > 0 && <span>{t('lab.v2.digest.dreams', { n: o.dreams })}</span>}
              {o.guardDrops > 0 && (
                <span>{t('lab.v2.digest.guardDrops', { count: o.guardDrops })}</span>
              )}
              {o.missingPostVectors > 0 && (
                <span>{t('lab.v2.digest.missingVectors', { n: o.missingPostVectors })}</span>
              )}
              {o.deviations > 0 && (
                <span className={s.warn}>
                  {t('lab.v2.digest.deviations', { count: o.deviations })}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className={s.grid}>
        {block(
          t('lab.v2.digest.mostIn'),
          'most-in',
          highlights.mostInCharacter.map((r) => <li key={r.postId}>{postLink(r)}</li>),
        )}
        {block(
          t('lab.v2.digest.leastIn'),
          'least-in',
          highlights.leastInCharacter.map((r) => <li key={r.postId}>{postLink(r)}</li>),
        )}
        {block(
          t('lab.v2.digest.mostAlike'),
          'most-alike',
          highlights.mostAlike.map((m) => (
            <li key={`${m.a.postId}-${m.b.postId}`}>
              {postLink(m.a)} ↔ {postLink(m.b)} <span className={s.num}>{fmtNum(m.sim)}</span>
            </li>
          )),
        )}
        {block(
          t('lab.v2.digest.conversations'),
          'conversations',
          highlights.conversations.map((c) => (
            <li key={c.postId}>
              <Link to={postPath(c.postId)}>{c.participants.map((u) => `@${u}`).join(' · ')}</Link>{' '}
              <span className={s.num}>{t('lab.v2.digest.comments', { count: c.comments })}</span>
              {c.crossArm && <span className={s.badge}>{t('lab.v2.digest.crossArm')}</span>}
            </li>
          )),
        )}
      </div>

      <p className={s.note}>
        {t('lab.v2.digest.interactions', {
          count: interactions.total,
          cross: interactions.crossArm,
          within: interactions.withinArm,
        })}
      </p>

      <div className={s.grid}>
        {block(
          t('lab.v2.digest.dreamsTitle'),
          'dreams',
          changes.dreams.map((d) => (
            <li key={`${d.username}-${d.capturedAt}`}>
              <Link to={userPath(d.username)}>@{d.username}</Link> <ArmName arm={d.arm} />{' '}
              <span className={s.num}>
                {t('lab.v2.digest.drift', { v: fmtNum(d.driftFromPrev) })}
              </span>
              {d.recent && (
                <RecentChange
                  recent={d.recent}
                  label={t('lab.v2.digest.recentChange', { username: d.username })}
                />
              )}
            </li>
          )),
        )}
        {block(
          t('lab.v2.digest.newWords'),
          'new-words',
          changes.newWords.map((w) => (
            <li key={w.token}>
              <strong>{w.token}</strong>{' '}
              <span className={s.note}>
                {t('lab.v2.digest.adoptedBy', {
                  origin: w.origin,
                  adopters: w.adopters.map((u) => `@${u}`).join(', '),
                })}
              </span>
            </li>
          )),
        )}
      </div>
    </Card>
  );
}
