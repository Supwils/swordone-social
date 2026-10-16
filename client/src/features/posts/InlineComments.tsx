import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { DotsThreeVertical } from '@phosphor-icons/react';
import * as commentsApi from '@/api/comments.api';
import { qk } from '@/api/queryKeys';
import type { ApiError, CommentDTO, Paginated, PostDTO } from '@/api/types';
import { Avatar, Spinner } from '@/components/primitives';
import { InfiniteScrollSentinel } from '@/components/InfiniteScrollSentinel';
import { useSession } from '@/stores/session.store';
import { useUI } from '@/stores/ui.store';
import { useDrafts } from '@/stores/draft.store';
import { formatRelative } from '@/lib/formatDate';
import { MarkdownBody } from './MarkdownBody';
import { useAutocomplete, applySelection } from './useAutocomplete';
import { AutocompleteDropdown } from './AutocompleteDropdown';
import s from './InlineComments.module.css';

interface Props {
  postId: string;
  open: boolean;
  indented?: boolean;
}

const COMMENT_AUTOSAVE_MS = 600;

export function InlineComments({ postId, open, indented = true }: Props) {
  const { t } = useTranslation();
  const me = useSession((st) => st.user);
  const language = useUI((st) => st.language);
  const qc = useQueryClient();
  const getDraft = useDrafts((st) => st.getDraft);
  const setDraftStore = useDrafts((st) => st.setDraft);
  const clearDraft = useDrafts((st) => st.clearDraft);
  const draftKey = `comment.${postId}`;

  // Compose state
  const [text, setText] = useState<string>(() => getDraft(draftKey)?.text ?? '');
  const [cursorPos, setCursorPos] = useState(0);
  const [acActiveIndex, setAcActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  // On-demand translation per comment (X-style); the auto path arrives as originalText.
  const [manualById, setManualById] = useState<Record<string, { text: string; from: 'en' | 'zh' }>>(
    {},
  );
  const [originalShown, setOriginalShown] = useState<Record<string, boolean>>({});
  const translateMutation = useMutation({
    mutationFn: (id: string) => commentsApi.translate(id, language),
    onSuccess: (out, id) => {
      if (out.translated) {
        setManualById((m) => ({ ...m, [id]: { text: out.text, from: out.from } }));
        setOriginalShown((o) => ({ ...o, [id]: false }));
      }
    },
    onError: (err) =>
      toast.error((err as unknown as ApiError).message ?? t('common.translateFailed')),
  });
  const toggleOriginal = (id: string) => setOriginalShown((o) => ({ ...o, [id]: !o[id] }));

  // Autocomplete for compose textarea
  const { trigger: acTrigger, results: acResults } = useAutocomplete(text, cursorPos);

  useEffect(() => {
    if (!text.trim()) {
      clearDraft(draftKey);
      return;
    }
    const h = window.setTimeout(() => setDraftStore(draftKey, text), COMMENT_AUTOSAVE_MS);
    return () => window.clearTimeout(h);
  }, [text, draftKey, setDraftStore, clearDraft]);

  const comments = useInfiniteQuery({
    queryKey: qk.posts.comments(postId, language),
    queryFn: ({ pageParam }) =>
      commentsApi.listForPost(postId, { cursor: pageParam, limit: 20, lang: language }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open,
  });

  const invalidateComments = () =>
    qc.invalidateQueries({ queryKey: qk.posts.comments(postId, language) });

  const bumpCount = (delta: 1 | -1) => {
    const updater = (old: InfiniteData<Paginated<PostDTO>> | undefined) => {
      if (!old?.pages) return old;
      return {
        ...old,
        pages: old.pages.map((pg) => ({
          ...pg,
          items: (pg.items ?? []).map((p) =>
            p.id === postId ? { ...p, commentCount: p.commentCount + delta } : p,
          ),
        })),
      };
    };
    qc.setQueriesData<InfiniteData<Paginated<PostDTO>>>({ queryKey: ['feed'] }, updater);
    // Only the author's posts infinite query — not byUsername / followStatus.
    qc.setQueriesData<InfiniteData<Paginated<PostDTO>>>(
      { predicate: (q) => q.queryKey[0] === 'users' && q.queryKey[2] === 'posts' },
      updater,
    );
  };

  const submit = useMutation({
    mutationFn: () => commentsApi.create(postId, { text }),
    onSuccess: () => {
      setText('');
      clearDraft(draftKey);
      invalidateComments();
      bumpCount(1);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => commentsApi.update(id, text),
    onSuccess: () => {
      setEditingId(null);
      setEditText('');
      invalidateComments();
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => commentsApi.remove(id),
    onSuccess: () => {
      invalidateComments();
      bumpCount(-1);
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || submit.isPending) return;
    submit.mutate();
  };

  // @mention selection handler
  const handleAcSelect = (item: (typeof acResults)[number]) => {
    if (!acTrigger) return;
    const replacement = 'username' in item ? item.username : item.slug;
    const { newText, newCursor } = applySelection(
      text,
      acTrigger.triggerIndex,
      acTrigger.query.length,
      acTrigger.prefix,
      replacement,
    );
    setText(newText);
    setAcActiveIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(newCursor, newCursor);
      textareaRef.current?.focus();
      setCursorPos(newCursor);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Autocomplete keyboard navigation
    if (acTrigger && acResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcActiveIndex((i) => Math.min(i + 1, acResults.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const selected = acResults[acActiveIndex];
        if (selected) {
          e.preventDefault();
          handleAcSelect(selected);
          return;
        }
      }
      if (e.key === 'Escape') {
        setCursorPos(0);
        return;
      }
    }
    // Submit on Cmd/Ctrl+Enter
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (text.trim() && !submit.isPending) submit.mutate();
    }
  };

  const startEdit = (c: CommentDTO) => {
    setMenuOpenId(null);
    setEditingId(c.id);
    setEditText(c.text);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const saveEdit = (id: string) => {
    if (!editText.trim() || updateMutation.isPending) return;
    updateMutation.mutate({ id, text: editText.trim() });
  };

  const handleDelete = (id: string) => {
    setMenuOpenId(null);
    toast(t('post.deleteCommentConfirm'), {
      action: {
        label: t('post.delete'),
        onClick: () => removeMutation.mutate(id),
      },
    });
  };

  const items = useMemo(() => comments.data?.pages.flatMap((p) => p.items) ?? [], [comments.data]);

  return (
    <div
      className={clsx(s.panel, indented && s.panelIndented, open && s.open)}
      // The collapse is `grid-template-rows: 0fr` + `overflow: hidden`, which
      // clips the panel without unmounting it. `aria-hidden` alone left the
      // compose box, the sign-in link and every loaded comment's controls
      // focusable, so tabbing down a feed dropped focus into an invisible
      // subtree once per card. `inert` is what actually takes them out of the
      // tab order; `aria-hidden` stays for browsers that do not support it.
      inert={!open}
      aria-hidden={!open}
      data-comments
    >
      <div className={s.inner}>
        <div className={s.content}>
          {me ? (
            <form onSubmit={onSubmit} className={s.compose}>
              <Avatar src={me.avatarUrl} name={me.displayName || me.username} size="sm" alt="" />
              <div className={s.composeField}>
                <div className={s.autocompleteWrap}>
                  <textarea
                    ref={textareaRef}
                    className={s.textarea}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setCursorPos(e.target.selectionStart);
                      setAcActiveIndex(0);
                    }}
                    onSelect={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart)}
                    onKeyDown={onKeyDown}
                    placeholder={t('post.commentPlaceholder')}
                    rows={1}
                    maxLength={2000}
                    aria-label="Write a comment"
                  />
                  {acTrigger && acResults.length > 0 && (
                    <AutocompleteDropdown
                      prefix={acTrigger.prefix}
                      results={acResults}
                      activeIndex={acActiveIndex}
                      onSelect={handleAcSelect}
                    />
                  )}
                </div>
                {text.trim().length > 0 && (
                  <div className={s.composeActions}>
                    <button type="button" className={s.cancelBtn} onClick={() => setText('')}>
                      {t('post.cancel')}
                    </button>
                    <button type="submit" className={s.submitBtn} disabled={submit.isPending}>
                      {submit.isPending ? <Spinner /> : t('post.postComment')}
                    </button>
                  </div>
                )}
              </div>
            </form>
          ) : (
            <p className={s.signIn}>
              <Link to="/login">{t('post.signInToComment')}</Link>
              {t('post.toJoinConversation')}
            </p>
          )}

          {comments.isLoading && (
            <div className={s.loading}>
              <Spinner />
            </div>
          )}

          {items.length > 0 && (
            <ul className={s.list}>
              {items.map((c, i) => (
                <li key={c.id} className={s.item} style={{ animationDelay: `${i * 30}ms` }}>
                  <Avatar
                    src={c.author.avatarUrl}
                    name={c.author.displayName || c.author.username}
                    size="sm"
                    alt=""
                  />
                  <div className={s.itemBody}>
                    <div className={s.itemHeader}>
                      <Link to={`/u/${c.author.username}`} className={s.author}>
                        {c.author.displayName || c.author.username}
                      </Link>
                      <span className={s.handle}>@{c.author.username}</span>
                      <time dateTime={c.createdAt} className={s.time}>
                        {formatRelative(c.createdAt)}
                      </time>
                      {me?.id === c.author.id && editingId !== c.id && (
                        <div className={s.menu}>
                          <button
                            type="button"
                            className={s.menuTrigger}
                            onClick={() => setMenuOpenId(menuOpenId === c.id ? null : c.id)}
                            onBlur={() =>
                              window.setTimeout(
                                () => setMenuOpenId((id) => (id === c.id ? null : id)),
                                150,
                              )
                            }
                            aria-label="Comment options"
                          >
                            <DotsThreeVertical size={14} weight="bold" />
                          </button>
                          {menuOpenId === c.id && (
                            <div className={s.menuDropdown}>
                              <button
                                type="button"
                                className={s.menuItem}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => startEdit(c)}
                              >
                                {t('post.edit')}
                              </button>
                              <button
                                type="button"
                                className={clsx(s.menuItem, s.menuItemDanger)}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => handleDelete(c.id)}
                              >
                                {t('post.delete')}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {editingId === c.id ? (
                      <form
                        className={s.editForm}
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveEdit(c.id);
                        }}
                      >
                        <textarea
                          className={s.textarea}
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={2}
                          maxLength={2000}
                          autoFocus
                        />
                        <div className={s.composeActions}>
                          <button type="button" className={s.cancelBtn} onClick={cancelEdit}>
                            {t('post.cancel')}
                          </button>
                          <button
                            type="submit"
                            className={s.submitBtn}
                            disabled={updateMutation.isPending || !editText.trim()}
                          >
                            {updateMutation.isPending ? <Spinner /> : t('post.save')}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className={s.itemText}>
                        {(() => {
                          const manual = manualById[c.id];
                          const original = c.originalText ?? (manual ? c.text : undefined);
                          const translated = c.originalText ? c.text : manual?.text;
                          const shown =
                            originalShown[c.id] && original ? original : (translated ?? c.text);
                          const canTranslate =
                            !original && c.lang !== language && c.text.trim().length > 0;
                          const pending =
                            translateMutation.isPending && translateMutation.variables === c.id;
                          return (
                            <>
                              <MarkdownBody source={shown} compact />
                              {c.editedAt && (
                                <span className={s.edited}> ({t('common.edited')})</span>
                              )}
                              {original ? (
                                <button
                                  type="button"
                                  className={s.translateBtn}
                                  onClick={() => toggleOriginal(c.id)}
                                >
                                  {originalShown[c.id]
                                    ? t('common.showTranslation')
                                    : t('common.showOriginal')}
                                </button>
                              ) : (
                                canTranslate && (
                                  <button
                                    type="button"
                                    className={s.translateBtn}
                                    disabled={pending}
                                    onClick={() => translateMutation.mutate(c.id)}
                                  >
                                    {pending ? t('common.translating') : t('common.translate')}
                                  </button>
                                )
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <InfiniteScrollSentinel
            hasNextPage={comments.hasNextPage}
            isFetching={comments.isFetchingNextPage}
            onLoadMore={() => comments.fetchNextPage()}
          />
        </div>
      </div>
    </div>
  );
}
