/**
 * Pure vector math for the agent-observation lab.
 *
 * All embeddings come from the bge-m3 daemon, which L2-normalises every vector
 * (`normalize_embeddings=True`). Cosine similarity is therefore just the dot
 * product — we never re-normalise here.
 */
import { meanOf } from './numeric';

/**
 * Cosine similarity of two (assumed L2-normalised) vectors. NULL on a length
 * mismatch or an empty vector: there is no similarity to report, and a
 * fabricated 0 used to enter fidelity, proximity and cohesion as data (the arms
 * report's `cosine` already answered null; the two now agree).
 */
export function cosineSim(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Cosine distance in [0, 2], null when `cosineSim` is. The clamp absorbs float round-off. */
export function cosineDist(a: number[], b: number[]): number | null {
  const sim = cosineSim(a, b);
  return sim === null ? null : Math.max(0, Math.min(2, 1 - sim));
}

/** Element-wise mean of equal-length vectors. Returns null for an empty input. */
export function centroid(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  if (dim === 0) return null;
  const out = new Array<number>(dim).fill(0);
  let used = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
    used++;
  }
  if (used === 0) return null;
  for (let i = 0; i < dim; i++) out[i] /= used;
  return out;
}

/**
 * Mean pairwise cosine similarity across a set of vectors — the population
 * "cohesion" metric. Higher = the population writes about more similar things.
 * Returns 1 for fewer than 2 vectors (nothing to compare).
 */
export function meanPairwiseCosine(vectors: number[][]): number {
  const vecs = vectors.filter((v) => v.length > 0);
  if (vecs.length < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const sim = cosineSim(vecs[i], vecs[j]);
      if (sim === null) continue; // a mismatched pair is not comparable, not "0 similar"
      sum += sim;
      pairs++;
    }
  }
  return pairs > 0 ? sum / pairs : 1;
}

/**
 * Variance of pairwise cosine similarities — low variance flags an echo-chamber
 * (everything equally similar). Returns 1 (treat as diverse) for fewer than 3
 * vectors, matching the runtime's fail-open echo check.
 */
export function pairwiseVariance(vectors: number[][]): number {
  const vecs = vectors.filter((v) => v.length > 0);
  if (vecs.length < 3) return 1;
  const sims: number[] = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const sim = cosineSim(vecs[i], vecs[j]);
      if (sim !== null) sims.push(sim);
    }
  }
  const mean = meanOf(sims);
  if (mean === null) return 1;
  return sims.reduce((s, x) => s + (x - mean) ** 2, 0) / sims.length;
}
