import { useQuery } from '@tanstack/react-query';
import { useDebounce } from '@/lib/useDebounce';
import * as usersApi from '@/api/users.api';
import * as tagsApi from '@/api/tags.api';
import type { TagDTO, UserLiteDTO } from '@/api/types';

export type AutocompleteTrigger = {
  prefix: '@' | '#';
  query: string;
  triggerIndex: number;
};

export type AutocompleteResult = UserLiteDTO | TagDTO;

export function detectTrigger(text: string, cursor: number): AutocompleteTrigger | null {
  const before = text.slice(0, cursor);
  // Match the last @ or # (preceded by start or whitespace) followed by non-whitespace chars
  const match = before.match(/(?:^|[\s\n])([@#])([\p{L}\p{N}_-]*)$/u);
  if (!match || match[2].length === 0) return null;
  const prefix = match[1] as '@' | '#';
  const query = match[2];
  // Find the actual position of this trigger character
  const triggerIndex = before.lastIndexOf(prefix);
  return { prefix, query, triggerIndex };
}

export function applySelection(
  text: string,
  triggerIndex: number,
  queryLen: number,
  prefix: '@' | '#',
  replacement: string,
): { newText: string; newCursor: number } {
  const insert = prefix + replacement + ' ';
  const newText = text.slice(0, triggerIndex) + insert + text.slice(triggerIndex + 1 + queryLen);
  return { newText, newCursor: triggerIndex + insert.length };
}

export function useAutocomplete(text: string, cursorPos: number) {
  const trigger = detectTrigger(text, cursorPos);
  const debouncedQuery = useDebounce(trigger?.query ?? '', 200);

  const mentionQ = useQuery({
    queryKey: ['autocomplete', '@', debouncedQuery],
    queryFn: ({ signal }) => usersApi.searchUsers(debouncedQuery, signal),
    enabled: trigger?.prefix === '@' && debouncedQuery.length >= 1,
    staleTime: 30_000,
  });

  const tagQ = useQuery({
    queryKey: ['autocomplete', '#', debouncedQuery],
    queryFn: ({ signal }) => tagsApi.search(debouncedQuery, signal),
    enabled: trigger?.prefix === '#' && debouncedQuery.length >= 1,
    staleTime: 30_000,
  });

  const results: AutocompleteResult[] =
    trigger?.prefix === '@' ? (mentionQ.data ?? []) : (tagQ.data ?? []);

  const isLoading = trigger?.prefix === '@' ? mentionQ.isLoading : tagQ.isLoading;

  return { trigger, results, isLoading };
}
