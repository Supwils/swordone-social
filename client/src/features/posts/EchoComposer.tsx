import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import * as postsApi from '@/api/posts.api';
import type { PostDTO, Visibility, ApiError } from '@/api/types';
import { Avatar, Button, Dialog } from '@/components/primitives';
import s from './EchoComposer.module.css';
import { invalidatePost, invalidatePostLists } from './postCache';
import { LIMITS } from '@/contract/limits';

function EchoPreview({ post }: { post: PostDTO }) {
  return (
    <Link to={`/p/${post.id}`} className={s.preview} tabIndex={-1}>
      <div className={s.previewAuthor}>
        <Avatar
          src={post.author.avatarUrl}
          name={post.author.displayName || post.author.username}
          size="sm"
          alt=""
        />
        <span className={s.previewName}>{post.author.displayName || post.author.username}</span>
        <span className={s.previewHandle}>@{post.author.username}</span>
      </div>
      {post.text && <p className={s.previewText}>{post.text}</p>}
      {post.images[0] && <img src={post.images[0].url} alt="" className={s.previewImg} />}
    </Link>
  );
}

interface Props {
  post: PostDTO;
  open: boolean;
  onClose: () => void;
}

export function EchoComposer({ post, open, onClose }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');

  const mutation = useMutation({
    mutationFn: () => postsApi.create({ text, visibility, echoOf: post.id }),
    onSuccess: () => {
      // The echo lands in every list (own profile included), and the
      // original's echoCount moved wherever it is shown.
      invalidatePostLists(qc);
      invalidatePost(qc, post.id);
      setText('');
      onClose();
      toast.success(t('post.echoPosted'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  function handleClose() {
    setText('');
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose();
      }}
      title={t('post.echo')}
    >
      <div className={s.inner}>
        <EchoPreview post={post} />

        <textarea
          className={s.textarea}
          placeholder={t('post.echoPlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={LIMITS.postText}
          rows={3}
          autoFocus
        />

        <div className={s.footer}>
          <select
            className={s.visibilitySelect}
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
            aria-label={t('post.visibility')}
          >
            <option value="public">{t('post.visibilityPublic')}</option>
            <option value="followers">{t('post.visibilityFollowers')}</option>
            <option value="private">{t('post.visibilityPrivate')}</option>
          </select>

          <Button
            variant="primary"
            disabled={!text.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? t('post.echoing') : t('post.echo')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
