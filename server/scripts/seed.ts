/**
 * Seed script — populate a dev database with believable dummy data.
 *
 * Usage:
 *   npm run seed           # append (idempotent on re-runs for users by username)
 *   npm run seed -- --reset  # truncate every table except `session` first
 *
 * Prints the target database first and refuses any host but localhost /
 * 127.0.0.1 / ::1 unless `--i-mean-remote` is passed (DATABASE_URL comes from
 * the environment or server/.env).
 *
 * All images use https://picsum.photos/... (deterministic via ?random=<n>) so we
 * don't depend on Unsplash rate limits. Passwords for all seeded users: `password123`.
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { eq, inArray, sql, type InferSelectModel } from 'drizzle-orm';
import { db, connectDb, disconnectDb } from '../src/db/client';
import { users, posts, comments, likes, follows, tags } from '../src/db/schema';
import { extractTags, extractMentionUsernames } from '../src/lib/extract';
import { truncateStatement } from '../src/db/tables';
import { describeDbTarget, remoteWriteRefusal } from '../src/db/target';
import { env } from '../src/config/env';

type UserRow = InferSelectModel<typeof users>;
type PostRow = InferSelectModel<typeof posts>;

const PASSWORD = 'password123';

const SEED_USERS = [
  { username: 'ada',       display: 'Ada Lovelace',      headline: 'Analytical Engine enthusiast' },
  { username: 'alan',      display: 'Alan Turing',       headline: 'On computable numbers' },
  { username: 'grace',     display: 'Grace Hopper',      headline: 'A ship in port is safe…' },
  { username: 'linus',     display: 'Linus Torvalds',    headline: 'Just a hobby, not big' },
  { username: 'margaret',  display: 'Margaret Hamilton', headline: 'Software engineering' },
  { username: 'denn',      display: 'Dennis Ritchie',    headline: 'K&R' },
  { username: 'kathleen',  display: 'Kathleen Booth',    headline: 'Assembly language' },
  { username: 'hedy',      display: 'Hedy Lamarr',       headline: 'Frequency hopping' },
  { username: 'djikstra',  display: 'Edsger Dijkstra',   headline: 'Shortest path' },
  { username: 'donald',    display: 'Donald Knuth',      headline: 'TAOCP vol. n' },
  { username: 'leslie',    display: 'Leslie Lamport',    headline: 'Happens-before' },
  { username: 'joan',      display: 'Joan Clarke',       headline: 'Bletchley Park' },
  { username: 'seymour',   display: 'Seymour Cray',      headline: 'Supercomputing' },
  { username: 'barbara',   display: 'Barbara Liskov',    headline: 'CLU and CLOS' },
  { username: 'claude',    display: 'Claude Shannon',    headline: 'Information theory' },
];

const POST_TEXTS = [
  'Morning coffee + a clean diff. ☕ #morning #ritual',
  'Rewrote the scheduler; 40% less allocation. The only way out is through. #perf',
  'Finished a draft of the letter. Some sentences won’t survive review but that’s fine. #writing',
  'Walked to the river after work. Light on water is underrated. #notebook',
  'Reading about category theory again. It clicks, then unclicks, then clicks differently. #math #learning',
  'Shipped the auth rewrite. Seven commits, two rollbacks, one clean main. #ship',
  'Pair-debugging with @alan over coffee. Found it in the tag extractor, unicode flag missing. #debugging',
  'Bought new notebook — Rhodia dotpad. #stationery',
  'Quiet rain on the studio roof. Rare good thing. #weather',
  'Watched @grace talk on teaching nanoseconds. Still the best explanation. #legends',
  'Small commit, big smile: replaced seven if-statements with one lookup. #refactor',
  'Tea instead of coffee today. The afternoon is more patient. #ritual',
  'Hiking this weekend. Phone will stay in the pack. #offline',
  'Reviewed a PR from @linus. Firm, direct, correct. #reviews',
  'The garden has opinions about my weeding. We disagree politely. #garden',
  'Deleted 3000 lines of legacy code and nothing broke. Doesn’t feel real. #cleanup',
  'Watched the sunrise from the fire-escape. Sort of worth it. #morning',
  'Soup for dinner. Bread tomorrow. #cooking',
  'Notes from the conference: bring an actual notebook, take fewer notes. #conference',
  'Playing with #typescript generics. My brain is crinkly. #learning',
  'Refactored the post composer. Less happens on every keystroke now. #frontend',
  'Found a bug that had been hiding behind a typo since 2019. A small archaeology. #history',
  'Made a sourdough starter. Named it Dijkstra. Shortest-path to bread. #dijkstra',
  'Reading @margaret on software assurance. Ought to reread yearly. #books',
  'Built a little CLI for my todo file. YAGNI won, 3 functions total. #tools',
  'Overcast all day. Got three hard things done. #focus',
  'Finally understand monads. (I do not finally understand monads.) #humor',
  'Letter to a friend: handwritten, 2 pages. Stamp cost less than a coffee. #analog',
  'Pushed a tiny css fix. Satisfaction per byte is off the charts. #frontend #design',
  'Morning pages again. The first paragraph is always garbage. #writing',
  'Replaced a 200-line helper with one well-named function. Felt like cheating. #refactor',
  'Studio smells like cedar. The heater is finally off. #spring',
  'Learned the difference between Lax and Strict cookies today, the hard way. #web #bugs',
  'Recipe test: miso-braised greens. Keeper. #cooking',
  'Slow commit morning. Drew a schema on paper first. #design',
  'The quiet after a release is its own kind of reward. #ship',
  'Short walk, long think. Problem solved in the kitchen, not the terminal. #walks',
  'The new feature flag system is just a map. Fine. Done. #code',
  'Reading old letters between @ada and @claude. Good brains. #history',
  'Mountain day. No pushes, no pulls. #offline',
  'Drew the follow graph with pen and ruler. It helped. #analog',
  'Three servings of rice and a small argument with autoconf. #evening',
  'Tiny keyboard, tiny progress, still progress. #focus',
  'Rewrote the pagination helper for the fifth time. Happy with this one. #code',
  'Typed whole email in Markdown, then pasted as plain text. Productivity defined. #workflow',
  'The tree outside my window has four new buds. #garden',
  'Wrote the tests first today. Finished early. #discipline',
  'Left the laptop at the office. Strange freedom. #offline',
  'Notebook entry 412: most bugs are just unexpressed assumptions. #reflection',
  'Read a long essay, took two short notes. Good ratio. #reading',
  'Quiet evening. A little #zen.',
];

async function reset() {
  // One TRUNCATE … CASCADE over every table but `session`: parallel DELETEs of
  // parents and children fail under the 0006 foreign keys.
  await db.execute(sql.raw(truncateStatement(['session'])));
  // eslint-disable-next-line no-console
  console.log('✓ reset every table except session');
}

function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

function imageFor(seed: string) {
  // picsum allows ?random=<n> style deterministic-ish images
  const hash = Array.from(seed).reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0);
  const id = Math.abs(hash) % 1000;
  return {
    url: `https://picsum.photos/seed/swil-${id}/1200/800`,
    width: 1200,
    height: 800,
  };
}

function avatarFor(username: string) {
  return `https://api.dicebear.com/7.x/thumbs/svg?seed=${encodeURIComponent(username)}`;
}

async function seed() {
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  // --- users -----------------------------------------------------------------
  const userRows: UserRow[] = [];
  for (const u of SEED_USERS) {
    const existing = (
      await db.select().from(users).where(eq(users.username, u.username)).limit(1)
    )[0];
    if (existing) {
      userRows.push(existing);
      continue;
    }
    const [user] = await db
      .insert(users)
      .values({
        username: u.username,
        usernameDisplay: u.display.split(' ')[0],
        email: `${u.username}@swil.local`,
        emailVerified: true,
        passwordHash,
        authProviders: [{ provider: 'local' }],
        displayName: u.display,
        bio: `I am ${u.display}. This is a seeded account for development.`,
        headline: u.headline,
        avatarUrl: avatarFor(u.username),
      })
      .returning();
    userRows.push(user);
  }
  // eslint-disable-next-line no-console
  console.log(`✓ users: ${userRows.length}`);

  // --- follow graph ----------------------------------------------------------
  let followEdgesCreated = 0;
  for (const follower of userRows) {
    const candidates = userRows.filter((u) => u.id !== follower.id);
    const targets = pickN(candidates, 3 + Math.floor(Math.random() * 5));
    for (const target of targets) {
      const inserted = await db
        .insert(follows)
        .values({ followerId: follower.id, followingId: target.id })
        .onConflictDoNothing()
        .returning();
      if (inserted.length) followEdgesCreated += 1;
    }
  }
  // Recompute follower/following counts
  for (const user of userRows) {
    const [followerCount, followingCount] = await Promise.all([
      db.$count(follows, eq(follows.followingId, user.id)),
      db.$count(follows, eq(follows.followerId, user.id)),
    ]);
    await db
      .update(users)
      .set({ followerCount, followingCount })
      .where(eq(users.id, user.id));
  }
  // eslint-disable-next-line no-console
  console.log(`✓ follows: ${followEdgesCreated}`);

  // --- tags (pre-materialize) ------------------------------------------------
  const allSlugs = new Set<string>();
  for (const text of POST_TEXTS) {
    for (const t of extractTags(text)) allSlugs.add(t.slug);
  }
  for (const slug of allSlugs) {
    await db.insert(tags).values({ slug, display: slug }).onConflictDoNothing();
  }
  // eslint-disable-next-line no-console
  console.log(`✓ tags: ${allSlugs.size}`);

  // --- posts -----------------------------------------------------------------
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const postRows: PostRow[] = [];
  for (let i = 0; i < POST_TEXTS.length; i++) {
    const text = POST_TEXTS[i];
    const author = userRows[i % userRows.length];
    const tagsRaw = extractTags(text);
    const mentions = extractMentionUsernames(text);

    const tagDocs = tagsRaw.length
      ? await db.select().from(tags).where(inArray(tags.slug, tagsRaw.map((t) => t.slug)))
      : [];
    const mentionDocs = mentions.length
      ? await db.select().from(users).where(inArray(users.username, mentions))
      : [];

    const img = i % 3 === 0 ? [imageFor(`post-${i}`)] : [];
    const createdAt = new Date(now - i * (dayMs / 2) - Math.floor(Math.random() * dayMs));

    const [post] = await db
      .insert(posts)
      .values({
        authorId: author.id,
        text,
        images: img,
        tagIds: tagDocs.map((t) => t.id),
        mentionIds: mentionDocs.map((u) => u.id),
        visibility: 'public',
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    postRows.push(post);

    if (tagDocs.length) {
      await db
        .update(tags)
        .set({ postCount: sql`${tags.postCount} + 1`, lastUsedAt: new Date() })
        .where(inArray(tags.id, tagDocs.map((t) => t.id)));
    }
    await db
      .update(users)
      .set({ postCount: sql`${users.postCount} + 1` })
      .where(eq(users.id, author.id));
  }
  // eslint-disable-next-line no-console
  console.log(`✓ posts: ${postRows.length}`);

  // --- comments --------------------------------------------------------------
  const commentBanks = [
    'good point',
    'agreed',
    'on the nose',
    'going to try this',
    'never thought of it that way',
    'saving this',
    'classic',
    'ha. needed this.',
    'beautifully said',
  ];
  let commentCount = 0;
  for (const post of postRows) {
    const n = Math.floor(Math.random() * 4);
    for (let j = 0; j < n; j++) {
      const commenter = userRows[Math.floor(Math.random() * userRows.length)];
      if (commenter.id === post.authorId) continue;
      await db.insert(comments).values({
        postId: post.id,
        authorId: commenter.id,
        text: commentBanks[Math.floor(Math.random() * commentBanks.length)],
      });
      commentCount += 1;
      await db
        .update(posts)
        .set({ commentCount: sql`${posts.commentCount} + 1` })
        .where(eq(posts.id, post.id));
    }
  }
  // eslint-disable-next-line no-console
  console.log(`✓ comments: ${commentCount}`);

  // --- likes -----------------------------------------------------------------
  let likeCount = 0;
  for (const post of postRows) {
    const likers = pickN(
      userRows.filter((u) => u.id !== post.authorId),
      Math.floor(Math.random() * 6),
    );
    for (const liker of likers) {
      const inserted = await db
        .insert(likes)
        .values({ userId: liker.id, targetType: 'post', targetId: post.id })
        .onConflictDoNothing()
        .returning();
      if (inserted.length) {
        likeCount += 1;
        await db
          .update(posts)
          .set({ likeCount: sql`${posts.likeCount} + 1` })
          .where(eq(posts.id, post.id));
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`✓ likes: ${likeCount}`);

  // eslint-disable-next-line no-console
  console.log('\n--- seeded users (all password: password123) ---');
  userRows.forEach((u) => {
    // eslint-disable-next-line no-console
    console.log(`  ${u.username.padEnd(12)} ${u.displayName}`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const reseed = args.includes('--reset');

  // Target first, before any connection: server/.env may point anywhere.
  // eslint-disable-next-line no-console
  console.log(`target database: ${describeDbTarget(env.DATABASE_URL)}`);
  const refusal = remoteWriteRefusal(env.DATABASE_URL, args);
  if (refusal) {
    // eslint-disable-next-line no-console
    console.error(refusal);
    process.exit(2);
  }

  await connectDb();

  if (reseed) await reset();
  await seed();

  await disconnectDb();
  // eslint-disable-next-line no-console
  console.log('\n✓ done');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
