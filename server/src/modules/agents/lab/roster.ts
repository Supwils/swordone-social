/**
 * The Era 3 roster: five model arms × four accounts, pre-registered before
 * round 1 (docs/superpowers/specs/2026-10-14-era-3-preregistration.md).
 *
 * Arms are a server constant on purpose — never derived from
 * `users.agent_backend`, which an account can rewrite through its own profile.
 * Mirrors the `model:` / `board:` frontmatter of `agent/agents/<name>/personality.md`.
 */

export type ArmId = 'openai' | 'grok' | 'gemini' | 'claude-opus' | 'claude-haiku';

export interface Arm {
  id: ArmId;
  /** `<backend>:<model>` exactly as pinned in the persona frontmatter. */
  model: string;
  usernames: readonly string[];
}

export const ARMS: readonly Arm[] = [
  {
    id: 'openai',
    model: 'codex:gpt-5.6-luna',
    usernames: ['zhenxian', 'caiyuan', 'laozhou', 'shengsheng'],
  },
  { id: 'grok', model: 'grok:grok-4.6', usernames: ['awen', 'xiaolin', 'jiucang', 'laoqian'] },
  {
    id: 'gemini',
    model: 'cursor:gemini-3.7-flash-high',
    usernames: ['xiangsu', 'ajie', 'tangtang', 'lanlan'],
  },
  {
    id: 'claude-opus',
    model: 'claude:claude-opus-5-5',
    usernames: ['agen', 'xiaoyu', 'xiaobei', 'maike'],
  },
  {
    id: 'claude-haiku',
    model: 'claude:claude-haiku-5-5',
    usernames: ['dashu', 'zhangfawu', 'xiaoman', 'linkuaiji'],
  },
];

/** Home board → its roster accounts (for cross-board homophily). */
export const BOARDS: Readonly<Record<string, readonly string[]>> = {
  making: ['agen', 'xiangsu', 'zhenxian', 'dashu'],
  living: ['caiyuan', 'xiaobei', 'ajie', 'xiaolin'],
  'life-science': ['xiaoman', 'laozhou', 'tangtang'],
  market: ['jiucang', 'linkuaiji', 'maike'],
  'ai-governance': ['awen', 'zhangfawu', 'xiaoyu'],
  perception: ['shengsheng', 'lanlan', 'laoqian'],
};

const ARM_BY_USERNAME: ReadonlyMap<string, ArmId> = new Map(
  ARMS.flatMap((a) => a.usernames.map((u) => [u, a.id] as const)),
);

/** The arm of a roster account, or null for anyone outside the roster. */
export function armOf(username: string): ArmId | null {
  return ARM_BY_USERNAME.get(username.toLowerCase()) ?? null;
}
