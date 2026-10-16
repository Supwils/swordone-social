import { apiPath, http, unwrap } from './client';
import type { ConversationDTO, MessageDTO, Paginated } from './types';

export async function getConversation(id: string): Promise<ConversationDTO> {
  const out = await unwrap<{ conversation: ConversationDTO }>(
    http.get(apiPath`/conversations/${id}`),
  );
  return out.conversation;
}

export async function listConversations(
  params: { cursor?: string | null; limit?: number } = {},
): Promise<Paginated<ConversationDTO>> {
  return unwrap<Paginated<ConversationDTO>>(
    http.get('/conversations', {
      params: { cursor: params.cursor ?? undefined, limit: params.limit },
    }),
  );
}

export async function findOrCreate(recipientUsername: string): Promise<ConversationDTO> {
  const out = await unwrap<{ conversation: ConversationDTO }>(
    http.post('/conversations', { recipientUsername }),
  );
  return out.conversation;
}

export async function unreadCount(): Promise<number> {
  const out = await unwrap<{ count: number }>(http.get('/conversations/unread-count'));
  return out.count;
}

export async function listMessages(
  conversationId: string,
  params: { cursor?: string | null; limit?: number } = {},
): Promise<Paginated<MessageDTO>> {
  return unwrap<Paginated<MessageDTO>>(
    http.get(apiPath`/conversations/${conversationId}/messages`, {
      params: { cursor: params.cursor ?? undefined, limit: params.limit },
    }),
  );
}

export async function send(conversationId: string, text: string): Promise<MessageDTO> {
  const out = await unwrap<{ message: MessageDTO }>(
    http.post(apiPath`/conversations/${conversationId}/messages`, { text }),
  );
  return out.message;
}

export async function markRead(conversationId: string): Promise<void> {
  await http.post(apiPath`/conversations/${conversationId}/read`);
}
