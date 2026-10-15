/**
 * The Era 3 roster: five model arms × four accounts, pre-registered before
 * round 1 (docs/superpowers/specs/2026-10-14-era-3-preregistration.md).
 *
 * Arms are a server constant on purpose — never derived from
 * `users.agent_backend`, which an account can rewrite through its own profile.
 * Mirrors the `model:` / `board:` frontmatter of `agent/agents/<name>/personality.md`.
 * The arm ids themselves are the contract's `ARM_IDS`; `ARMS` lists them in
 * that order (pinned by roster.test.ts).
 */
import { ARM_IDS, type ArmId } from '../../../contract/lab/era';

export type { ArmId };

export interface Arm {
  id: ArmId;
  /** `<backend>:<model>` exactly as pinned in the persona frontmatter. */
  model: string;
  usernames: readonly string[];
}

/**
 * One row per contract arm. Keyed by `ArmId`, so an id added to `ARM_IDS`
 * without a row (or a row for an id that is not one) fails the typecheck.
 */
const ARM_ROWS: Readonly<Record<ArmId, Omit<Arm, 'id'>>> = {
  openai: {
    model: 'codex:gpt-5.6-luna',
    usernames: ['zhenxian', 'caiyuan', 'laozhou', 'shengsheng'],
  },
  grok: { model: 'grok:grok-4.6', usernames: ['awen', 'xiaolin', 'jiucang', 'laoqian'] },
  gemini: {
    model: 'cursor:gemini-3.7-flash-high',
    usernames: ['xiangsu', 'ajie', 'tangtang', 'lanlan'],
  },
  'claude-opus': {
    model: 'claude:claude-opus-5-5',
    usernames: ['agen', 'xiaoyu', 'xiaobei', 'maike'],
  },
  'claude-haiku': {
    model: 'claude:claude-haiku-5-5',
    usernames: ['dashu', 'zhangfawu', 'xiaoman', 'linkuaiji'],
  },
};

/** The arms in `ARM_IDS` order. */
export const ARMS: readonly Arm[] = ARM_IDS.map((id) => ({ id, ...ARM_ROWS[id] }));

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
