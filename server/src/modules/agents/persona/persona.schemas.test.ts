import { describe, expect, it } from 'vitest';
import { snapshotIngest } from './persona.schemas';

describe('persona.schemas snapshotIngest aspectDrift', () => {
  const base = {
    contentHash: 'e'.repeat(64),
    embedding: Array(64).fill(0.01),
    archivePath: 'agents/zenith/personality.md',
  };

  it('accepts a valid aspectDrift block', () => {
    const parsed = snapshotIngest.parse({
      ...base,
      aspectDrift: {
        mode: 'shadow',
        promptVersion: 1,
        values: 0.9,
        style: 0.8,
        topic: 0.7,
        breached: [],
      },
    });
    expect(parsed.aspectDrift?.mode).toBe('shadow');
  });

  it('rejects a sim outside [-1, 1]', () => {
    expect(() =>
      snapshotIngest.parse({
        ...base,
        aspectDrift: {
          mode: 'aspect',
          promptVersion: 1,
          values: 1.5,
          style: 0.8,
          topic: 0.7,
          breached: [],
        },
      }),
    ).toThrow();
  });

  it('rejects an unknown breached aspect name', () => {
    expect(() =>
      snapshotIngest.parse({
        ...base,
        aspectDrift: {
          mode: 'aspect',
          promptVersion: 1,
          values: 0.9,
          style: 0.8,
          topic: 0.7,
          breached: ['vibe'],
        },
      }),
    ).toThrow();
  });

  it('is optional so legacy snapshots without it still validate', () => {
    const parsed = snapshotIngest.parse(base);
    expect(parsed.aspectDrift).toBeUndefined();
  });
});
