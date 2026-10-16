import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { posts, comments, tags } from '../db/schema';
import { env } from '../config/env';
import type { PostRow, CommentRow, TagRow, PostDTOContext, CommentDTOContext } from './dto';
import { detectLang, type ReadTranslation } from './lang';

export interface TranslateOptions {
  /** false → leave bodies alone (auto-translate off) but still localize tags. */
  content?: boolean;
}

const TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';
// Feed and post reads await this before responding, so a hung upstream must
// not become a hung feed — past this the originals are served instead.
const TRANSLATE_TIMEOUT_MS = 4_000;

/** `translations || {lang: text}` in SQL — a read-modify-write from a request-start
 *  snapshot lets two concurrent readers (en + zh) overwrite each other's key. */
function mergeTranslation(lang: string, text: string) {
  return sql`coalesce(${sql.raw('translations')}, '{}'::jsonb) || ${JSON.stringify({ [lang]: text })}::jsonb`;
}

/** Cache writes in flight. Fire-and-forget for the response; tracked so a test can wait them out. */
const pendingCacheWrites = new Set<Promise<unknown>>();

function persistInBackground(updates: Array<Promise<unknown>>): void {
  if (updates.length === 0) return;
  // Persisting the cache must never block the response, nor fail it.
  const job: Promise<unknown> = Promise.all(updates)
    .catch(() => undefined)
    .finally(() => pendingCacheWrites.delete(job));
  pendingCacheWrites.add(job);
}

/** Test hook: resolves once every cache write started so far has settled. */
export async function settleTranslationCacheWrites(): Promise<void> {
  await Promise.all(Array.from(pendingCacheWrites));
}

function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

function needsTranslation(text: string, targetLang: string): boolean {
  if (!text.trim()) return false;
  const isChinese = hasChinese(text);
  if (targetLang === 'zh' && isChinese) return false;
  if (targetLang === 'en' && !isChinese) return false;
  return true;
}

async function translateBatch(texts: string[], targetLang: string): Promise<string[]> {
  if (texts.length === 0) return [];
  const apiLang = targetLang === 'zh' ? 'zh-CN' : targetLang;
  const res = await fetch(`${TRANSLATE_URL}?key=${env.GOOGLE_TRANSLATE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, target: apiLang, format: 'text' }),
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
  });
  if (!res.ok) return texts;
  const data = (await res.json()) as {
    data: { translations: Array<{ translatedText: string }> };
  };
  return data.data.translations.map((t) => t.translatedText);
}

export async function translatePosts(
  postList: PostRow[],
  ctxById: Map<string, PostDTOContext>,
  targetLang: string,
  opts: TranslateOptions = {},
): Promise<void> {
  if (!env.GOOGLE_TRANSLATE_API_KEY) return;

  const pending: PostRow[] = [];

  for (const post of opts.content === false ? [] : postList) {
    const id = post.id;
    if (!post.text?.trim()) continue;

    const cached = post.translations?.[targetLang];
    if (cached) {
      const ctx = ctxById.get(id);
      if (ctx) {
        ctx.translatedText = cached;
        ctx.originalLang = detectLang(post.text);
      }
      continue;
    }

    if (needsTranslation(post.text, targetLang)) {
      pending.push(post);
    }
  }

  if (pending.length > 0) {
    try {
      const translated = await translateBatch(
        pending.map((p) => p.text),
        targetLang,
      );

      const updates: Array<Promise<unknown>> = [];

      for (let i = 0; i < pending.length; i++) {
        const post = pending[i];
        const translatedText = translated[i];
        if (translatedText && translatedText !== post.text) {
          const ctx = ctxById.get(post.id);
          if (ctx) {
            ctx.translatedText = translatedText;
            ctx.originalLang = detectLang(post.text);
          }
          // Mutate in memory too (as `translateTags` does): a row held in a
          // cache — the explore summary's featured post — then serves the
          // translation from `translations` on the next request instead of
          // paying Translate again until the cache expires.
          post.translations = { ...(post.translations ?? {}), [targetLang]: translatedText };
          // `AND text = <source>`: an edit that lands while the provider is
          // answering clears `translations` and changes `text`; without the
          // guard this write would put the OLD body's translation back.
          updates.push(
            db
              .update(posts)
              .set({ translations: mergeTranslation(targetLang, translatedText) })
              .where(and(eq(posts.id, post.id), eq(posts.text, post.text))),
          );
        }
      }

      persistInBackground(updates);
    } catch {
      // Translation API failed — originals will be used
    }
  }

  // Also translate tags embedded in post contexts
  const uniqueTags: TagRow[] = [];
  const seenSlugs = new Set<string>();
  for (const ctx of ctxById.values()) {
    for (const tag of ctx.tags) {
      if (!seenSlugs.has(tag.slug)) {
        seenSlugs.add(tag.slug);
        uniqueTags.push(tag);
      }
    }
  }
  if (uniqueTags.length > 0) {
    await translateTags(uniqueTags, targetLang);
  }

  for (const ctx of ctxById.values()) {
    ctx.lang = targetLang;
  }
}

/** `translatePosts` for a read: a null translation (first-party agent) leaves originals. */
export async function translatePostsForRead(
  postList: PostRow[],
  ctxById: Map<string, PostDTOContext>,
  t: ReadTranslation | null | undefined,
): Promise<void> {
  if (t) await translatePosts(postList, ctxById, t.lang, { content: t.content });
}

/** `translateComments` for a read: a null translation (first-party agent) leaves originals. */
export async function translateCommentsForRead(
  commentList: CommentRow[],
  ctxByCommentId: Map<string, CommentDTOContext>,
  t: ReadTranslation | null | undefined,
): Promise<void> {
  if (t) await translateComments(commentList, ctxByCommentId, t.lang, { content: t.content });
}

export async function translateComments(
  commentList: CommentRow[],
  ctxByCommentId: Map<string, CommentDTOContext>,
  targetLang: string,
  opts: TranslateOptions = {},
): Promise<void> {
  if (!env.GOOGLE_TRANSLATE_API_KEY) return;
  if (opts.content === false) return;

  const pending: CommentRow[] = [];

  for (const comment of commentList) {
    const id = comment.id;
    if (!comment.text?.trim() || comment.status === 'deleted') continue;

    const cached = comment.translations?.[targetLang];
    if (cached) {
      const ctx = ctxByCommentId.get(id);
      if (ctx) ctx.translatedText = cached;
      continue;
    }

    if (needsTranslation(comment.text, targetLang)) {
      pending.push(comment);
    }
  }

  if (pending.length === 0) return;

  try {
    const translated = await translateBatch(
      pending.map((c) => c.text),
      targetLang,
    );

    const updates: Array<Promise<unknown>> = [];

    for (let i = 0; i < pending.length; i++) {
      const comment = pending[i];
      const translatedText = translated[i];
      if (translatedText && translatedText !== comment.text) {
        const ctx = ctxByCommentId.get(comment.id);
        if (ctx) ctx.translatedText = translatedText;
        // Same edit race as posts: only cache against the body that was translated.
        updates.push(
          db
            .update(comments)
            .set({ translations: mergeTranslation(targetLang, translatedText) })
            .where(and(eq(comments.id, comment.id), eq(comments.text, comment.text))),
        );
      }
    }

    persistInBackground(updates);
  } catch {
    // Translation API failed
  }
}

export async function translateTags(tagList: TagRow[], targetLang: string): Promise<void> {
  if (!env.GOOGLE_TRANSLATE_API_KEY) return;

  const pending: TagRow[] = [];

  for (const tag of tagList) {
    if (tag.translations?.[targetLang]) continue;
    if (needsTranslation(tag.display, targetLang)) {
      pending.push(tag);
    }
  }

  if (pending.length === 0) return;

  try {
    const translated = await translateBatch(
      pending.map((t) => t.display),
      targetLang,
    );

    const updates: Array<Promise<unknown>> = [];

    for (let i = 0; i < pending.length; i++) {
      const tag = pending[i];
      const translatedDisplay = translated[i];
      if (translatedDisplay && translatedDisplay !== tag.display) {
        const merged = { ...(tag.translations ?? {}), [targetLang]: translatedDisplay };
        // Mutate in memory so toTagDTO in the same request sees the translation.
        tag.translations = merged;
        updates.push(
          db
            .update(tags)
            .set({ translations: mergeTranslation(targetLang, translatedDisplay) })
            .where(eq(tags.id, tag.id)),
        );
      }
    }

    persistInBackground(updates);
  } catch {
    // Translation API failed
  }
}
