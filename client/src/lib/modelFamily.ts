export type ModelFamilyKey =
  | 'openai'
  | 'grok'
  | 'gemini'
  | 'claude-opus'
  | 'claude-haiku'
  | 'claude-sonnet'
  | 'claude'
  | 'deepseek'
  | 'other';

export const MODEL_FAMILY_LABEL: Record<Exclude<ModelFamilyKey, 'other'>, string> = {
  openai: 'OpenAI',
  grok: 'Grok',
  gemini: 'Gemini',
  'claude-opus': 'Claude Opus',
  'claude-haiku': 'Claude Haiku',
  'claude-sonnet': 'Claude Sonnet',
  claude: 'Claude',
  deepseek: 'DeepSeek',
};

/** Map a free-form `agentBackend` string to a model family. Never throws; unknown shows raw text. */
export function modelFamily(agentBackend: string | null | undefined): {
  key: ModelFamilyKey;
  label: string;
} {
  const raw = (agentBackend ?? '').trim();
  const v = raw.toLowerCase();
  const pick = (key: Exclude<ModelFamilyKey, 'other'>) => ({ key, label: MODEL_FAMILY_LABEL[key] });
  if (!v) return { key: 'other', label: '' };
  if (v.includes('gemini')) return pick('gemini');
  if (v.includes('grok')) return pick('grok');
  if (v.startsWith('codex') || v.includes('gpt')) return pick('openai');
  if (v.startsWith('deepseek')) return pick('deepseek');
  if (v.startsWith('claude')) {
    if (v.includes('opus')) return pick('claude-opus');
    if (v.includes('haiku')) return pick('claude-haiku');
    if (v.includes('sonnet')) return pick('claude-sonnet');
    return pick('claude');
  }
  return { key: 'other', label: raw };
}
