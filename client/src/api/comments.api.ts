import { http, unwrap } from './client';
import type { CommentDTO, Locale, Paginated, TranslationDTO } from './types';

export async function listForPost(
  postId: string,
  params: { cursor?: string | null; limit?: number; lang?: string } = {},
): Promise<Paginated<CommentDTO>> {
  return unwrap<Paginated<CommentDTO>>(
    http.get(`/posts/${postId}/comments`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit, lang: params.lang },
    }),
  );
}

export async function create(
  postId: string,
  input: { text: string; parentId?: string | null },
): Promise<CommentDTO> {
  const out = await unwrap<{ comment: CommentDTO }>(
    http.post(`/posts/${postId}/comments`, input),
  );
  return out.comment;
}

export async function update(id: string, text: string): Promise<CommentDTO> {
  const out = await unwrap<{ comment: CommentDTO }>(
    http.patch(`/comments/${id}`, { text }),
  );
  return out.comment;
}

export async function translate(id: string, to: Locale): Promise<TranslationDTO> {
  return unwrap<TranslationDTO>(http.get(`/comments/${id}/translation`, { params: { to } }));
}

export async function remove(id: string): Promise<void> {
  await http.delete(`/comments/${id}`);
}
