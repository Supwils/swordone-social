import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as usersApi from '@/api/users.api';
import { qk } from '@/api/queryKeys';

interface Options {
  /** Shortest query that is sent; shorter ones stay idle. Default 1. */
  minLength?: number;
  staleTime?: number;
  enabled?: boolean;
  /** Keep the previous results on screen while the next query loads. */
  keepPrevious?: boolean;
}

/**
 * The one user-search query: composer @-autocomplete, the DM picker and the
 * command palette all read through it, so they share cache entries and the
 * same abort-on-supersede behaviour. Callers trim / debounce the text.
 */
export function useUserSearch(query: string, opts: Options = {}) {
  const { minLength = 1, staleTime = 30_000, enabled = true, keepPrevious = false } = opts;
  return useQuery({
    queryKey: qk.users.search(query),
    queryFn: ({ signal }) => usersApi.searchUsers(query, signal),
    enabled: enabled && query.length >= minLength,
    staleTime,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  });
}
