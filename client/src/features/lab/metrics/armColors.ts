/**
 * Era 3 arm identity for the dashboard: display order, names and colours.
 * Colours are existing theme tokens, so both themes work without new palette.
 */
import { ARM_IDS, type ArmId } from '@/contract/limits';
import { MODEL_FAMILY_LABEL } from '@/lib/modelFamily';

/** Display order — the pre-registration's arm order, owned by the contract. */
export { ARM_IDS };

export const ARM_COLOR: Record<ArmId, string> = {
  openai: 'var(--color-success)',
  grok: 'var(--color-text)',
  gemini: 'var(--color-info)',
  'claude-opus': 'var(--color-accent)',
  'claude-haiku': 'var(--color-warning)',
};

/** Brand names, identical in every locale (shared with the account badge). */
export const ARM_LABEL: Record<ArmId, string> = Object.fromEntries(
  ARM_IDS.map((id) => [id, MODEL_FAMILY_LABEL[id]]),
) as Record<ArmId, string>;
