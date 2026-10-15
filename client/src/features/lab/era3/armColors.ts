/**
 * Era 3 arm identity for the dashboard: display order, names and colours.
 * Colours are existing theme tokens, so both themes work without new palette.
 */
import type { ArmId } from '@/features/lab/types';

/** Display order — the pre-registration's arm order (mirrors server `ARMS`). */
export const ARM_IDS: readonly ArmId[] = [
  'openai',
  'grok',
  'gemini',
  'claude-opus',
  'claude-haiku',
];

export const ARM_COLOR: Record<ArmId, string> = {
  openai: 'var(--color-success)',
  grok: 'var(--color-text)',
  gemini: 'var(--color-info)',
  'claude-opus': 'var(--color-accent)',
  'claude-haiku': 'var(--color-warning)',
};

/** Brand names, identical in every locale. */
export const ARM_LABEL: Record<ArmId, string> = {
  openai: 'OpenAI',
  grok: 'Grok',
  gemini: 'Gemini',
  'claude-opus': 'Claude Opus',
  'claude-haiku': 'Claude Haiku',
};
