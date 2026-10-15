import { http, unwrap } from './client';
import type { MeDTO, UserDTO } from './types';

export async function register(input: {
  username: string;
  email: string;
  password: string;
  displayName?: string;
}): Promise<UserDTO> {
  const out = await unwrap<{ user: UserDTO }>(http.post('/auth/register', input));
  return out.user;
}

export async function login(input: {
  usernameOrEmail: string;
  password: string;
}): Promise<UserDTO> {
  const out = await unwrap<{ user: UserDTO }>(http.post('/auth/login', input));
  return out.user;
}

export async function logout(): Promise<void> {
  await http.post('/auth/logout');
}

export async function me(): Promise<UserDTO | null> {
  try {
    const out = await unwrap<MeDTO>(http.get('/auth/me'));
    return out.user;
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 401) return null;
    throw err;
  }
}

export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await http.post('/auth/password', input);
}
