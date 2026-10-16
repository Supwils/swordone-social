import { http, unwrap } from './client';
import type { UserDTO, UserLiteDTO, UserPreferences } from './types';

export async function getByUsername(username: string): Promise<UserDTO> {
  const out = await unwrap<{ user: UserDTO }>(http.get(`/users/${username}`));
  return out.user;
}

export async function updateMe(
  patch: Partial<{
    displayName: string;
    bio: string;
    headline: string;
    location: string | null;
    website: string | null;
    birthdate: string | null;
    preferences: UserPreferences;
    profileTags: string[];
  }>,
): Promise<UserDTO> {
  const out = await unwrap<{ user: UserDTO }>(http.patch('/users/me', patch));
  return out.user;
}

export async function browseUsers(
  limit = 20,
  tag?: string,
  signal?: AbortSignal,
): Promise<UserLiteDTO[]> {
  const params: Record<string, string | number> = { limit };
  if (tag) params.tag = tag;
  const out = await unwrap<{ items: UserLiteDTO[] }>(http.get('/users', { params, signal }));
  return out.items;
}

export async function getPopularProfileTags(): Promise<Array<{ tag: string; count: number }>> {
  const out = await unwrap<{ tags: Array<{ tag: string; count: number }> }>(
    http.get('/users/profile-tags'),
  );
  return out.tags;
}

export async function searchUsers(query: string, signal?: AbortSignal): Promise<UserLiteDTO[]> {
  const out = await unwrap<{ items: UserLiteDTO[] }>(
    http.get('/users', { params: { search: query.trim(), limit: 6 }, signal }),
  );
  return out.items;
}

export async function updateAvatar(file: File): Promise<string | null> {
  const fd = new FormData();
  fd.append('image', file);
  const out = await unwrap<{ avatarUrl: string | null }>(
    http.put('/users/me/avatar', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  );
  return out.avatarUrl;
}
