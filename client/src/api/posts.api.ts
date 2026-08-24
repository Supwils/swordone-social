import { http, unwrap } from './client';
import type { Locale, PostDTO, TranslationDTO, Visibility, Paginated } from './types';

export async function getById(id: string, lang?: string): Promise<PostDTO> {
  // Without `lang` an anonymous reader gets the post in English however the UI
  // is set: resolveLang falls back to the query param, and only a signed-in
  // reader has a stored preference to fall back to instead.
  const out = await unwrap<{ post: PostDTO }>(
    http.get(`/posts/${id}`, { params: lang ? { lang } : undefined }),
  );
  return out.post;
}

export async function create(input: {
  text: string;
  visibility?: Visibility;
  images?: File[];
  video?: File | null;
  echoOf?: string;
}): Promise<PostDTO> {
  const fd = new FormData();
  fd.append('text', input.text);
  fd.append('visibility', input.visibility ?? 'public');
  for (const img of input.images ?? []) fd.append('images', img);
  if (input.video) fd.append('video', input.video);
  if (input.echoOf) fd.append('echoOf', input.echoOf);

  const out = await unwrap<{ post: PostDTO }>(
    http.post('/posts', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  );
  return out.post;
}

export async function update(
  id: string,
  patch: { text?: string; visibility?: Visibility },
): Promise<PostDTO> {
  const out = await unwrap<{ post: PostDTO }>(http.patch(`/posts/${id}`, patch));
  return out.post;
}

export async function remove(id: string): Promise<void> {
  await http.delete(`/posts/${id}`);
}

export async function translate(id: string, to: Locale): Promise<TranslationDTO> {
  return unwrap<TranslationDTO>(http.get(`/posts/${id}/translation`, { params: { to } }));
}

export async function getShowcase(lang?: string): Promise<PostDTO[]> {
  const out = await unwrap<{ posts: PostDTO[] }>(
    http.get('/posts/showcase', { params: lang ? { lang } : undefined }),
  );
  return out.posts;
}

export async function searchPosts(params: {
  q?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<Paginated<PostDTO>> {
  const p: Record<string, string | number> = {};
  if (params.q?.trim()) p.q = params.q.trim();
  if (params.cursor) p.cursor = params.cursor;
  if (params.limit) p.limit = params.limit;
  return unwrap<Paginated<PostDTO>>(http.get('/posts/search', { params: p, signal: params.signal }));
}
