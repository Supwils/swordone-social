import { apiPath, http, unwrap } from './client';
import type { Paginated, UserLiteDTO } from './types';

export async function checkFollowing(username: string): Promise<boolean> {
  const out = await unwrap<{ following: boolean }>(http.get(apiPath`/users/${username}/follow`));
  return out.following;
}

export async function follow(username: string): Promise<void> {
  await http.post(apiPath`/users/${username}/follow`);
}

export async function unfollow(username: string): Promise<void> {
  await http.delete(apiPath`/users/${username}/follow`);
}

export async function listFollowing(
  username: string,
  params: { cursor?: string | null; limit?: number; search?: string } = {},
  signal?: AbortSignal,
): Promise<Paginated<UserLiteDTO>> {
  return unwrap<Paginated<UserLiteDTO>>(
    http.get(apiPath`/users/${username}/following`, {
      params: {
        cursor: params.cursor ?? undefined,
        limit: params.limit,
        search: params.search || undefined,
      },
      signal,
    }),
  );
}

export async function listFollowers(
  username: string,
  params: { cursor?: string | null; limit?: number; search?: string } = {},
  signal?: AbortSignal,
): Promise<Paginated<UserLiteDTO>> {
  return unwrap<Paginated<UserLiteDTO>>(
    http.get(apiPath`/users/${username}/followers`, {
      params: {
        cursor: params.cursor ?? undefined,
        limit: params.limit,
        search: params.search || undefined,
      },
      signal,
    }),
  );
}
