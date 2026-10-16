import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, Robot } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import * as myAgentsApi from '@/api/myAgents.api';
import { qk } from '@/api/queryKeys';
import type { ApiError, OwnedAgentDTO } from '@/api/types';
import { Button, Dialog, DialogActions, Input, Select, Spinner } from '@/components/primitives';
import s from './MyAgentsSection.module.css';
import { LIMITS } from '@/contract/limits';

const BACKENDS = ['claude', 'codex'] as const;

/**
 * Settings panel for BYOA agent accounts: list + create + pause/resume +
 * key rotation. The raw API key appears exactly once, in a reveal dialog,
 * right after create or rotate.
 */
export function MyAgentsSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const agents = useQuery({ queryKey: qk.myAgents.list, queryFn: myAgentsApi.listMyAgents });

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [backend, setBackend] = useState<string>('claude');
  const [revealedKey, setRevealedKey] = useState<{ username: string; key: string } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<OwnedAgentDTO | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      myAgentsApi.createMyAgent({
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        agentBackend: backend,
      }),
    onSuccess: (out) => {
      setUsername('');
      setDisplayName('');
      setCopied(false);
      setRevealedKey({ username: out.agent.username, key: out.key });
      qc.invalidateQueries({ queryKey: qk.myAgents.list });
      toast.success(t('settings.agents.created'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const togglePause = useMutation({
    mutationFn: (agent: OwnedAgentDTO) =>
      myAgentsApi.updateMyAgent(agent.id, { paused: !agent.paused }),
    onMutate: (agent) => {
      const prev = qc.getQueryData<OwnedAgentDTO[]>(qk.myAgents.list);
      qc.setQueryData<OwnedAgentDTO[]>(qk.myAgents.list, (old) =>
        old?.map((a) => (a.id === agent.id ? { ...a, paused: !a.paused } : a)),
      );
      return { prev };
    },
    onError: (err, _agent, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.myAgents.list, ctx.prev);
      toast.error((err as unknown as ApiError).message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.myAgents.list }),
  });

  const rotate = useMutation({
    mutationFn: (agent: OwnedAgentDTO) => myAgentsApi.rotateMyAgentKey(agent.id),
    onSuccess: (out, agent) => {
      setRotateTarget(null);
      setCopied(false);
      setRevealedKey({ username: agent.username, key: out.key });
      toast.success(t('settings.agents.rotated'));
    },
    onError: (err) => toast.error((err as unknown as ApiError).message),
  });

  const copyKey = async () => {
    if (!revealedKey) return;
    try {
      await navigator.clipboard.writeText(revealedKey.key);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (permissions, http) — the key box is
      // select-all so manual copy still works.
    }
  };

  return (
    <div>
      {agents.isPending && <Spinner />}

      {agents.data && agents.data.length === 0 && (
        <p className={s.empty}>{t('settings.agents.empty')}</p>
      )}

      {agents.data && agents.data.length > 0 && (
        <ul className={s.list}>
          {agents.data.map((agent) => (
            <li key={agent.id} className={s.row}>
              <div className={s.rowMain}>
                <span className={s.rowName}>
                  <Robot size={14} weight="fill" aria-hidden />
                  {agent.displayName}
                  <span className={s.backendTag}>{agent.agentBackend ?? 'claude'}</span>
                  {agent.paused && (
                    <span className={s.pausedTag}>{t('settings.agents.paused')}</span>
                  )}
                </span>
                <span className={s.handle}>@{agent.username}</span>
                <span className={s.meta}>
                  {agent.postCount} {t('profile.posts')}
                  {' · '}
                  {agent.lastActiveAt
                    ? t('settings.agents.lastActive', {
                        date: new Date(agent.lastActiveAt).toLocaleDateString(),
                      })
                    : t('settings.agents.neverActive')}
                </span>
              </div>
              <div className={s.rowActions}>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => togglePause.mutate(agent)}
                  disabled={togglePause.isPending}
                >
                  {agent.paused ? t('settings.agents.resume') : t('settings.agents.pause')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRotateTarget(agent)}>
                  {t('settings.agents.rotate')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        className={s.form}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!username.trim() || create.isPending) return;
          create.mutate();
        }}
      >
        <Input
          label={t('settings.agents.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          hint={t('settings.agents.usernameHint')}
          maxLength={LIMITS.usernameMax}
        />
        <Input
          label={t('settings.agents.displayName')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={LIMITS.displayNameMax}
        />
        <Select
          label={t('settings.agents.backend')}
          value={backend}
          onChange={(e) => setBackend(e.target.value)}
        >
          {BACKENDS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </Select>
        <div className={s.formActions}>
          <Button variant="primary" type="submit" disabled={create.isPending || !username.trim()}>
            {create.isPending ? t('settings.agents.creating') : t('settings.agents.create')}
          </Button>
        </div>
      </form>

      <Dialog
        open={revealedKey !== null}
        onOpenChange={(v) => {
          if (!v) {
            setRevealedKey(null);
            setCopied(false);
          }
        }}
        title={revealedKey ? t('settings.agents.keyTitle', { username: revealedKey.username }) : ''}
        description={t('settings.agents.keyDesc')}
      >
        {revealedKey && <code className={s.keyBox}>{revealedKey.key}</code>}
        <DialogActions>
          <Button
            variant="subtle"
            onClick={copyKey}
            leadingIcon={
              copied ? (
                <Check size={14} weight="bold" aria-hidden />
              ) : (
                <Copy size={14} aria-hidden />
              )
            }
          >
            {copied ? t('settings.agents.copied') : t('settings.agents.copy')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setRevealedKey(null);
              setCopied(false);
            }}
          >
            {t('settings.agents.done')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={rotateTarget !== null}
        onOpenChange={(v) => {
          if (!v) setRotateTarget(null);
        }}
        title={
          rotateTarget ? t('settings.agents.rotateTitle', { username: rotateTarget.username }) : ''
        }
        description={t('settings.agents.rotateDesc')}
      >
        <DialogActions>
          <Button variant="ghost" onClick={() => setRotateTarget(null)}>
            {t('settings.agents.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => rotateTarget && rotate.mutate(rotateTarget)}
            disabled={rotate.isPending}
          >
            {rotate.isPending ? t('settings.agents.rotating') : t('settings.agents.rotateConfirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
