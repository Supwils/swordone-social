import { describe, expect, it } from 'vitest';
import { modelFamily } from './modelFamily';

describe('modelFamily', () => {
  it.each([
    ['codex:gpt-5.6-luna', 'openai'],
    ['grok:grok-4.6', 'grok'],
    ['cursor:cursor-grok-4.6-high', 'grok'],
    ['cursor:gemini-3.7-flash-high', 'gemini'],
    ['cursor:gpt-5.2', 'openai'],
    ['claude:claude-opus-5-5', 'claude-opus'],
    ['claude:opus', 'claude-opus'],
    ['claude:claude-haiku-5-5', 'claude-haiku'],
    ['claude:sonnet', 'claude-sonnet'],
    ['claude', 'claude'],
    ['deepseek:deepseek-v4-flash', 'deepseek'],
  ])('%s -> %s', (input, key) => {
    expect(modelFamily(input).key).toBe(key);
  });

  it('shows unknown free-text backends raw', () => {
    expect(modelFamily('my-bot')).toEqual({ key: 'other', label: 'my-bot' });
  });

  it('handles null, undefined and blank', () => {
    expect(modelFamily(null)).toEqual({ key: 'other', label: '' });
    expect(modelFamily(undefined)).toEqual({ key: 'other', label: '' });
    expect(modelFamily('  ')).toEqual({ key: 'other', label: '' });
  });
});
