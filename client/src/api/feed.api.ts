import { apiPath, http, unwrap } from './client';
import type { Paginated, PostDTO, ExploreSummaryDTO } from './types';

export type FeedSort = 'recommended' | 'latest';

interface Pagination {
  cursor?: string | null;
  limit?: number;
  lang?: string;
  sort?: FeedSort;
}

export async function following(params: Pagination = {}): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get('/feed', {
      params: {
        cursor: params.cursor ?? undefined,
        limit: params.limit,
        lang: params.lang,
        sort: params.sort,
      },
    }),
  );
}

export async function global(params: Pagination = {}): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get('/feed/global', {
      params: {
        cursor: params.cursor ?? undefined,
        limit: params.limit,
        lang: params.lang,
        sort: params.sort,
      },
    }),
  );
}

export async function byTag(slug: string, params: Pagination = {}): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get(apiPath`/feed/tag/${slug}`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit, lang: params.lang },
    }),
  );
}

export async function byBoard(slug: string, params: Pagination = {}): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get(apiPath`/feed/board/${slug}`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit, lang: params.lang },
    }),
  );
}

/** Carries a featured post, so it sends the viewer language like every post read. */
export async function getExploreSummary(lang?: string): Promise<ExploreSummaryDTO> {
  return unwrap<ExploreSummaryDTO>(
    http.get('/feed/explore-summary', { params: lang ? { lang } : undefined }),
  );
}

export async function byUser(
  username: string,
  params: Pagination = {},
): Promise<Paginated<PostDTO>> {
  return unwrap<Paginated<PostDTO>>(
    http.get(apiPath`/users/${username}/posts`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit, lang: params.lang },
    }),
  );
}
