import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import request from 'supertest';
import { createApp } from '../../app';
import { db } from '../../db/client';
import { notifications, posts } from '../../db/schema';
import { resetDb } from '../../test/db-reset';
import { envelopeData, expectContract } from '../../test/contract';
import { paginated } from '../../contract/common';
import {
  ConversationDTOSchema,
  MessageDTOSchema,
  NotificationDTOSchema,
} from '../../contract/messaging';

/**
 * Conversation, message and notification bodies as SERIALISED by the real
 * router stack, against the contract.
 */

const conversationBody = z.object({ conversation: ConversationDTOSchema }).strict();

async function signUp(username: string) {
  const agent = request.agent(createApp());
  const res = await agent
    .post('/api/v1/auth/register')
    .send({ username, email: `${username}@example.com`, password: 'password123' })
    .expect(201);
  return { agent, id: (res.body.data.user as { id: string }).id };
}

// Reset once: every test signs up its own, distinctly named accounts and
// asserts only on them, so tests do not need a fresh database each.
beforeAll(resetDb, 30_000);

describe('conversations and messages', () => {
  it('create, send, list, get and page messages', async () => {
    const alice = await signUp('alice');
    await signUp('bobby');

    const opened = await alice.agent
      .post('/api/v1/conversations')
      .send({ recipientUsername: 'bobby' })
      .expect(201);
    const { conversation } = expectContract(conversationBody, envelopeData(opened.body));
    expect(conversation.lastMessage).toBeNull();

    const sent = await alice.agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .send({ text: 'hello bobby' })
      .expect(201);
    expectContract(z.object({ message: MessageDTOSchema }).strict(), envelopeData(sent.body));

    const list = await alice.agent.get('/api/v1/conversations').expect(200);
    const page = expectContract(paginated(ConversationDTOSchema), envelopeData(list.body));
    expect(page.items[0].lastMessage?.text).toBe('hello bobby');

    const one = await alice.agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    expectContract(conversationBody, envelopeData(one.body));

    const msgs = await alice.agent
      .get(`/api/v1/conversations/${conversation.id}/messages`)
      .expect(200);
    const msgPage = expectContract(paginated(MessageDTOSchema), envelopeData(msgs.body));
    expect(msgPage.items.map((m) => m.text)).toEqual(['hello bobby']);
  });
});

describe('notifications', () => {
  it('GET /notifications is a cursor page of NotificationDTO for every ref kind', async () => {
    const ada = await signUp('ada');
    const bob = await signUp('bob');

    // Real producers: a DM (message ref), a like and a comment on ada's post.
    const opened = await bob.agent
      .post('/api/v1/conversations')
      .send({ recipientUsername: 'ada' })
      .expect(201);
    const convoId = (opened.body.data.conversation as { id: string }).id;
    await bob.agent
      .post(`/api/v1/conversations/${convoId}/messages`)
      .send({ text: 'hi ada' })
      .expect(201);
    const [post] = await db
      .insert(posts)
      .values({ authorId: ada.id, text: 'ada writes' })
      .returning();
    await bob.agent.post(`/api/v1/posts/${post.id}/like`).expect((r) => {
      expect([200, 201]).toContain(r.status);
    });
    await bob.agent
      .post(`/api/v1/posts/${post.id}/comments`)
      .send({ text: 'nice post' })
      .expect(201);
    // A follow (no refs at all), seeded directly.
    await db.insert(notifications).values({ recipientId: ada.id, actorId: bob.id, type: 'follow' });

    const res = await ada.agent.get('/api/v1/notifications').expect(200);
    const page = expectContract(paginated(NotificationDTOSchema), envelopeData(res.body));
    expect(new Set(page.items.map((n) => n.type))).toEqual(
      new Set(['message', 'like', 'comment', 'follow']),
    );
  });
});
