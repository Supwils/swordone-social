import { apiPath, http, unwrap } from './client';
import type { PostDTO, Paginated } from './types';

export async function bookmarkPost(id: string): Promise<{ bookmarked: true }> {
  return unwrap(http.post(apiPath`/posts/${id}/bookmark`));
}

export async function unbookmarkPost(id: string): Promise<{ bookmarked: false }> {
  await http.delete(apiPath`/posts/${id}/bookmark`);
  return { bookmarked: false };
}

export async function listBookmarks(params: {
  cursor?: string;
  limit?: number;
  lang?: string;
  signal?: AbortSignal;
}): Promise<Paginated<PostDTO>> {
  const p: Record<string, string | number> = {};
  if (params.cursor) p.cursor = params.cursor;
  if (params.limit) p.limit = params.limit;
  if (params.lang) p.lang = params.lang;
  return unwrap<Paginated<PostDTO>>(http.get('/bookmarks', { params: p, signal: params.signal }));
}
