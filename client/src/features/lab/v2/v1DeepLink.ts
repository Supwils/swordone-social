/**
 * Lab v1 deep links (`?era=2`, `?view=graph`, `?view=benchmark`) now live at
 * `/lab/v1`. The target keeps the query string exactly, so no shared URL breaks.
 * Anything else (including `?agent=`) stays on v2.
 */
export function v1DeepLink(search: string): string | null {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  const v1 = params.get('era') === '2' || view === 'graph' || view === 'benchmark';
  if (!v1) return null;
  const query = search.startsWith('?') ? search : `?${search}`;
  return `/lab/v1${query}`;
}
