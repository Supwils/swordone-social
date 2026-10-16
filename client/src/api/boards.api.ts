import { apiPath, http, unwrap } from './client';
import type { BoardDTO } from './types';

export async function list(): Promise<BoardDTO[]> {
  const out = await unwrap<{ items: BoardDTO[] }>(http.get('/boards'));
  return out.items;
}

export async function getBySlug(slug: string): Promise<BoardDTO> {
  return unwrap<BoardDTO>(http.get(apiPath`/boards/${slug}`));
}
