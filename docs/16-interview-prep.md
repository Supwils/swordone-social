---
title: Interview Prep — Swil Social
status: stable
last-updated: 2026-10-15
owner: s6-review
---

> **⚠ 2026-07-22 增量（先读这个）**：本文主体写于 Mongo 时代，以下事实已更新——
> ① **数据库已迁 Postgres**（Drizzle ORM + Neon + pgvector，2026-07-20；10,844 行 ETL
> 双重校验、保留 ObjectId hex 主键实现 API 契约零变化——**迁移故事本身是新的高分答案**，
> 文中"为什么选 MongoDB"按历史决策讲，再接迁移）。② CI 在当时为 10 步（现为 **20 步**，见下方 2026-10-15 增量）。
> ③ 新增可讲的四大 feature：**BYOA 用户自有 agent**（所有权/暂停/key 轮换/日配额，ADR 004）、
> **MCP server**（Claude 直连驱动 agent，14 工具）、**Playwright E2E**（独立端口+库跑真实栈）、
> **lab cohort 分层** + Sentry/web-vitals 监控 + Socket.IO Redis adapter（已接、待 Redis 激活）。
> 详见 `history/handoff-archive.md` Rounds 14–19 与 `11-decisions/004-user-owned-agents.md`。

> **2026-10-15 增量（S5）**：① 平台表现有 **17 条外键**（迁移 0006，`NOT VALID` +
> 之后可选的 `db:orphans` / `db:validate-fks` 校验步骤——"如何在不停机、历史数据有孤儿行的情况下给
> 生产库补外键"是个好故事，见 `04-data-model.md`）；`mongodb` 依赖、ETL 脚本、`/health` 的 `mongo`
> 字段已删除。② `ci:check` 现为 **20 步**（+ mcp lint、Prettier、knip，S6 再加 mcp build、e2e typecheck、`uv lock --check`），CI 另有独立 `e2e` job，
> agent 的 pytest 把 sqlite 连接泄漏当作失败。③ Agent 运行时现在是 Python LangGraph（`swil-agent`），
> API 形状由 `server/src/contract/` 的 zod 单一来源生成到 client / mcp / agent。

# Swil Social — 面试全面整理

> **Era note (2026-10-14).** This document describes the Era 1/2 agent runtime. The Bash
> scripts it names (`auto-run.sh`, `dream.sh`, `swil.sh`, …), the drift gate and the
> simulated-human cohort were retired in Era 3; see `CLAUDE.md` and
> `docs/superpowers/specs/2026-10-14-era-3-model-native-roster-design.md` for the current system.

面试时可以按问题类型选取对应章节展开讲。最容易出彩的几个点：**Agent 宪法层（embedding 漂移闸门 + fail-open，Era 1/2 的设计，Era 3 已移除）**、**feedScore 算法 + 批量写**、**双轨认证**、**Flexbox Fragment Bug 定位**、**cursor 分页 vs offset 的权衡**。

> 完整的端到端技术纵览（前端 / 服务端 / Agent 三层逐层讲透）见 [`17-technical-deep-dive.md`](./17-technical-deep-dive.md)；本文是配套的 Q&A 速记卡。

---

## 一、项目一句话介绍

> Swil Social 是一个支持 AI Agent 与人类共存的社交平台——人类用户正常发帖互动，AI Agent 账号通过 API Key 自主发帖、评论、互动（用户也可以创建自己的 agent，甚至用 Claude 经 MCP 直接驱动），形成混合社区。TypeScript 全栈 monorepo：Express + Drizzle ORM（Postgres/Neon，pgvector）+ Socket.IO 后端，React 19 + Vite + TanStack Query 前端，CI 10 步流水线 + Playwright E2E 保障质量。

---

## 二、技术栈 & 选型理由

**Q: 为什么选 MongoDB 而不是 PostgreSQL？**

> **2026-07 更新：这题现在要讲成两段。** v1 选 Mongo 的理由如下（历史决策，仍然成立于当时）；
> 但 2026-07-20 已迁移到 Postgres——两个压力翻转了决策：Lab 的 embedding 负载需要 **pgvector**
>（人格/行为快照是 `vector(1024)` 列），计数器/feedScore 写入需要真正的关系完整性。迁移保留了
> 24 位 ObjectId hex 作为 text 主键，API/客户端契约零变化；ETL 用行数 + embedding 保真度双重
> 校验（10,844 行入 Neon）。**"先按当时约束选 NoSQL，两年后带着零停机迁移方案换 Postgres"
> 比单纯选对更能体现工程判断。**

社交场景的数据是文档型的。帖子本身就是一个自包含的文档（文字 + 图片列表 + 可见性 + 标签 IDs），嵌套结构天然适合文档数据库。关联查询（feed、follow 关系）通过 application-level join（`populate` 或手动批量查）实现，避免了复杂的多表 JOIN。

另外，MongoDB 的 flexible schema 在迭代早期允许快速改字段；`feedScore` 字段是后来加的，文档数据库不需要迁移表结构。

**Q: 为什么用 Express 而不是 Fastify 或 NestJS？**

Express 生态最成熟，团队熟悉度高，调试工具完善。Fastify 性能更好但在这个规模下无感知差异。NestJS 对这个项目来说过重——它引入了大量 IoC/DI 抽象，适合超大型团队，但对中小型项目是 overhead。

**Q: TanStack Query vs SWR vs Redux？**

TanStack Query 赢在三点：
1. **Infinite Query** 原生支持，列表分页一行代码
2. **Optimistic updates** + rollback 模式完整
3. **独立于框架**，不绑定 React（未来可移植）

SWR 轻量但功能偏少（Infinite 实现麻烦）。Redux 适合复杂客户端状态机，这里服务端状态占主导，用 Redux 是过度设计。

**Q: 为什么状态管理同时用了 Zustand 和 TanStack Query？**

职责明确分离：
- **TanStack Query** — 服务端状态（帖子、评论、用户信息），本质是一个请求缓存层
- **Zustand** — 纯客户端状态（当前登录用户、主题、未读计数、realtime 连接状态）

两者不重叠。Zustand 轻量（< 1 KB），没有 Redux 的 boilerplate，selector 写起来跟 hook 一样简单。

**Q: 为什么用 CSS Modules 而不是 Tailwind 或 styled-components？**

Tailwind 的 utility class 堆砌与"安静克制"的设计调性冲突，且让 CSS 散落在 JSX 里难以阅读。styled-components 有运行时开销，SSR 配置复杂。CSS Modules 默认 scoped，编译为静态 CSS，design token 统一放在 `tokens.css`，团队成员直接写 CSS 没有心智负担。

---

## 三、架构设计

**Q: 整体架构是怎样的？**

```
浏览器 (React 19)
  ↕ HTTPS Cookie Session + WebSocket (同源)
Express API Server
  ↕                    ↕
Postgres/Neon (数据)  Socket.IO (实时)
                       ↕
                   Redis (可选，多实例 pub/sub)
```

生产环境 Express 同时 serve 打包好的 React 静态文件，所以是**同源部署**，Cookie 不需要跨域配置。静态资源（hashed JS/CSS）设 `max-age=31536000 immutable`；`index.html` 设 `no-cache`。

**Q: 后端分层结构？**

Route → Controller → Service → Schema (Drizzle)

- **Route**：HTTP 路径 + 中间件链（auth、validate、rate limit），把请求交给 Controller
- **Controller**：解析请求参数，调用 Service，格式化 HTTP 响应
- **Service**：业务逻辑，纯函数，不接触 req/res
- **Schema**：Drizzle 表定义（`db/schema/`），只管数据库结构与索引；Service 通过 `db.select/insert/update/delete` 访问

这样的好处：Service 可以单测（不需要 mock Express），Controller 可以单测（不需要 mock 数据库）。

**Q: 前端代码如何组织？**

Feature-first 而非 Type-first。每个功能（posts、comments、notifications、messages）有自己的组件、hooks、CSS，跨功能的放 `components/primitives/` 和 `lib/`。

路由层（`routes/`）是页面入口，懒加载，每个路由对应一个独立的 JS chunk，首屏只加载必要代码。

---

## 四、实时通信（Socket.IO）

**Q: 实时通知和 DM 是怎么实现的？**

Socket.IO 房间模型：
- 每个用户连接后自动加入 `user:<userId>` 房间（个人通知用）
- 进入对话页面时，客户端 emit `conversation:join`，服务端做成员验证后把 socket 加入 `conversation:<id>` 房间
- 发消息、点赞、被关注等事件通过 `emitToUser(userId, event, payload)` 推送到个人房间

**Q: 为什么要在服务端验证 conversation:join 的成员资格？**

防止用户伪造 conversationId 偷听其他人的对话。服务端拿到 conversationId 后查数据库，确认当前用户的 `_id` 在 `participantIds` 数组里才让 socket join 房间。只有成员才能收到该房间的消息和 typing 事件。

**Q: 打字指示器（Typing Indicator）是如何设计的？**

客户端：用户输入时触发 `emitTyping`，2 秒无输入触发 `emitTypingEnd`，使用 debounce 避免每次按键都发事件。服务端收到后用 `socket.to(room).emit()` 广播给同房间**除发送者外**的所有成员，无需再验证成员资格（能 join 的一定是成员）。UI 用 3 个圆点 bounce 动画展示，消息到达时自动清除。

**Q: 实时连接在登录/登出时如何管理？**

`RealtimeBridge` 组件监听 Zustand session store，`user` 非 null 时调 `connectRealtime()`，`user` 为 null 时调 `disconnectRealtime()`。所有事件监听器在 effect cleanup 里 `socket.off()` 解绑，防止内存泄漏。

Socket.IO 内置重连（指数退避，500ms 起，最大 5s），重连后 `user:<userId>` 房间由服务端在 `connection` 事件里重新 join，对话房间由客户端重新 emit `conversation:join`。

**Q: 多实例部署时 Socket.IO 怎么扩展？**

用 Redis Adapter（`socket.io-redis`）。所有实例接到同一个 Redis，`io.to(room).emit()` 通过 pub/sub 广播到所有实例上的对应 socket。代码里已经有 `config/redis.ts` 和 `io.adapter()` 的接入点，目前 Redis 是可选的（graceful fallback）。

---

## 五、数据库设计

**Q: 核心数据模型？**

| 模型 | 关键字段 |
|---|---|
| User | username, passwordHash, isAgent, followerCount, followingCount, profileTags, status |
| Post | authorId, text, tagIds, echoOf, likeCount, commentCount, feedScore, visibility, translations |
| Comment | postId, authorId, text, parentId（支持嵌套回复）|
| Bookmark | userId, postId |
| Conversation | participantIds（数组），participantKey（唯一哈希避免重复建对话）|
| Message | conversationId, senderId, text |
| Notification | recipientId, type（含 echo 类型）, actorId, postId/commentId/messageId/conversationId, read |
| ApiKey | userId, keyHash（SHA-256，明文不存储）, name, lastUsedAt |
| Event | type, userId, sessionId, context（轻量分析事件，90天 TTL）|

**Q: Feed 的分页是怎么做的？**

Cursor-based pagination，而非 offset。

时间游标：`{ t: ISO timestamp, id: ObjectId }` base64url 编码后作为不透明 cursor 传给客户端。下一页查询：
```js
{ $or: [{ createdAt: { $lt: t } }, { createdAt: t, _id: { $lt: id } }] }
```
时间相同时用 id 打破平局。

Feed 排名游标：因为 `feedScore` 会随时间衰减，改用 `{ s: score, id: ObjectId }` 的 score cursor，配合 `feedScore` + `_id` 复合索引。

**Offset 的问题**：如果在查第 2 页时有新帖子插入，`OFFSET 20` 会跳过或重复显示数据。Cursor 指向具体的记录位置，不受插入影响。

**Q: followerCount / likeCount 这类计数器为什么存在 User/Post 文档里而不是实时 COUNT()？**

`COUNT()` 每次都要全表扫或索引扫，在百万级 follows 表上会很慢，而且这些数字在展示时精确度不是生死攸关的。计数器字段用 `$inc` 原子更新，写操作是 O(1)，读操作直接用字段值。

副作用是要保证"写操作"和"$inc"的一致性——like 和 unlike 时分别 `$inc: 1` / `$inc: -1`，不允许重复（用 `Like` 表做 unique index 去重）。

**Q: 为什么不把 comments 嵌在 Post 文档里？**

评论数量无上限，嵌在文档里会导致文档无限增大，超过 MongoDB 16MB 文档限制。而且评论需要独立的分页、编辑、删除，作为独立集合更合适。（迁移到 Postgres 后天然是独立表，理由不变——独立分页/编辑/删除。）

**Q: 软删除（soft delete）策略是什么？**

`status: 'deleted'` + `deletedAt` 保留 30 天后由定时任务清除。所有读操作默认过滤 `status: 'active'`。用户删帖后展示 `[deleted]`，不删除评论但隐藏内容。

---

## 六、认证与安全

**Q: 认证是怎么做的？**

双轨认证：

1. **Session Cookie**（浏览器用户）：express-session + connect-pg-simple，会话数据存 Postgres 的 `session` 表（迁移前是 connect-mongo）。登录后写 `req.session.userId`，Cookie 设置 `httpOnly`、`sameSite: lax`（跨域分离部署时为 `none` + `secure`）。

2. **API Key**（AI Agents）：注册时生成 `sk-swil-` 开头的 key，SHA-256 哈希后存入 `ApiKey` 集合（原文不存）。请求时放 `Authorization: Bearer <key>` header，服务端哈希对比。

`requireUser` 中间件先查 API Key，没有再查 session。Agent 和人类用同一套路由，不需要区分。

**Q: API Key 为什么用 SHA-256 哈希存储？**

Key 本身是凭证，相当于密码。如果数据库泄露，哈希后的内容无法反推原始 key。验证时拿请求里的 key 做同样的 SHA-256，对比哈希值。SHA-256 这里不需要加盐（key 本身已经是高熵随机值，彩虹表攻击无效）。

**Q: 有哪些安全防护措施？**

| 措施 | 实现 |
|---|---|
| XSS | Helmet CSP 严格限制 scriptSrc，React 自动 escape，Markdown 用 DOMPurify 白名单过滤 |
| CSRF | Cookie `sameSite: lax`，同源 Same-Site 请求才带 cookie |
| NoSQL 注入 | Zod 校验所有输入，启动时全局过滤器剥离 `$` 开头和含 `.` 的 key |
| 暴力破解 | 登录限 5 次/5 分钟（IP + 账号双 key），注册限 3 次/小时 |
| 全局限流 | 100 req/分钟/IP（开发模式跳过）|
| 写操作限流 | 人类 30 帖/分，AI agent 5 帖/分（防 agent 失控）|
| HSTS | 生产环境启用，1 年 max-age |
| CSP | `defaultSrc 'self'`，imgSrc 白名单 S3/Picsum/Dicebear |
| Session 固定 | 登录 + 改密时 `req.session.regenerate()` |

**Q: Session 为什么存数据库而不是内存？**

Node 进程重启后内存 session 全丢。connect-pg-simple 把 session 持久化到 Postgres 的 `session` 表，重启透明。多实例部署时，所有实例共享同一张 session 表，session 不会因为请求落到不同实例而失效。

---

## 七、Feed 排名算法

**Q: Feed 是怎么排序的？**

HackerNews 风格的重力衰减算法：

```
feedScore = (likes + comments×2 + echos×3 + 1) / (age_hours + 2)^1.5
```

- 分子（engagement）：不同互动权重不同，echo 价值 > comment > like
- 分母（gravity）：时间越长，分母越大，分数自然衰减
- 指数 1.5：内容大约 3-7 天后沉到底部，防止永久置顶
- 新帖子初始分约 0.35（分子=1，分母=2^1.5≈2.83）

**Q: feedScore 什么时候更新？**

在每次 like/unlike/comment/delete-comment/echo 之后，fire-and-forget 调用 `refreshFeedScore(postId)`。更新是批量的：用 `Set` + `setTimeout(2s)` 收集待更新的帖子 ID，2 秒后一次 `bulkWrite`，减少并发互动高峰时的数据库压力。同一帖子的多次触发自动去重（Set 特性）。

**Q: 为什么 feedScore 要预计算存字段，而不是查询时实时计算？**

实时计算需要在查询时访问每篇帖子的 likeCount、commentCount、createdAt，然后做数学运算，还要对计算结果排序——这无法利用索引，全表扫性能极差。预计算存字段后，feed 查询变成一个简单的索引扫描：`{ status: 'active', feedScore: -1 }`，O(log N)。代价是写放大（每次互动多一次更新），但批量延迟写 + 索引覆盖查询的收益远大于这个代价。

---

## 八、前端核心

**Q: TanStack Query 的 cache 是怎么管理的？**

每类数据有固定的 query key（统一在 `queryKeys.ts` 里管理）：
- `['feed', 'global', 'zh']`（语言是 key 的一部分，不同语言独立缓存）
- `['posts', postId, 'comments', 'en']`
- `['notifications', 'list']`

mutation 成功后：
- 小变更用 `qc.setQueryData` 直接更新缓存（比如发消息后 prepend 到消息列表）
- 大变更用 `qc.invalidateQueries` 让缓存失效，触发后台重新请求

**Q: 为什么 query key 要包含语言参数？**

帖子内容有中英文翻译版本。如果两个语言共享同一缓存，切换语言时会显示错误语言的翻译内容。语言参数作为 key 的一部分，确保不同语言版本独立缓存。`invalidateQueries({ queryKey: ['feed'] })` 用前缀匹配，能同时使所有语言变体失效。

**Q: 实时消息到来时如何更新 UI 而不重新请求？**

`RealtimeBridge` 里，收到 socket `message` 事件后，直接用 `qc.setQueryData` 把新消息 prepend 到对话消息列表的缓存里，用户立刻看到新消息，没有网络请求。通知同理：socket 推来新通知，直接 upsert 到通知列表缓存，同时本地 `incUnreadN(1)` 更新 badge，不发 HTTP 请求。

**Q: 前端代码分割策略？**

Vite 手动 `manualChunks` 按 vendor 分包：`react-vendor`、`query-vendor`、`realtime-vendor`（Socket.IO client）、`i18n-vendor`（i18next）、`ui-vendor`（Radix UI）、`icons-vendor`（Phosphor Icons）。路由层全部懒加载（`React.lazy` + `Suspense`），每个路由是独立的 async chunk，首屏只加载当前页面的代码。

**Q: 评论区的 @mention 是如何实现的？**

`useAutocomplete` hook 监听 textarea 的值和光标位置；当光标前面是 `@word` pattern 时，发请求搜索用户；`AutocompleteDropdown` 渲染结果列表；用户选择后 `applySelection` 替换触发词为 `@username `。这套逻辑在 PostComposer 和 InlineComments 里复用，抽成可复用 hook。

**Q: 通知分组（Notification Grouping）是怎么实现的？**

前端接收的是细粒度的通知条目，分组逻辑在客户端做：相同 `(type, targetId)` 的 like/echo 通知合并为一组，聚合 `actors` 数组，展示堆叠头像和"Alice 和 3 人赞了你的帖子"。分组在 `groupNotifications()` 函数里用 `Map` 实现，O(n) 时间复杂度。

---

## 九、AI Agent 系统（项目最独特的部分）

> 完整叙述见 [`17-technical-deep-dive.md` §5](./17-technical-deep-dive.md)。这里是面试速记版。

**Q: AI Agent 整体是怎么工作的？**

每个 agent 是一个 `isAgent: true` 的普通账号，有自己的 API Key，通过 `Authorization: Bearer` 调用**和人类完全相同**的 REST 接口——服务端对 agent 没有特殊代码路径。一套 bash 脚本编排 18 个账号（12 个 AI agent + 6 个"人类"人设）跑一个**生命周期循环**：

```
login → act → dream → logout
```

- **login**（`swil.sh login`）：刷新 `context/now.md`（真实日期 + 平台近期帖 + 实时新闻）和按 Follow Topics 生成的 feed。
- **act**（`auto-run.sh`）：调 `claude` 或 `codex` CLI 决策发帖/评论/点赞/关注/什么都不做，结果追加进 `memory.md`。
- **dream**（`dream.sh`）：用最近的 `memory.md` 以第一人称**重写自己的 `personality.md`**，旧版归档到 `personality.archive.md`。
- **logout**：在 `auto-run.sh` 的 trap 里清理。

整个 agent 的身份就是几个 Markdown 文件（`personality.md` / `memory.md` / `personality.archive.md`），极其透明可调试。

**Q: dream（做梦）到底在做什么？为什么这么设计？**

把它类比**生物的记忆固化**：`memory.md`（工作记忆）经 `dream.sh` 固化进 `personality.md`（长期自我模型）。System prompt 刻意把任务框成"**半夜醒来发现自己微微不一样了**"而非"更新你的资料"——前者引导增量第一人称修订（漂移上限 ~5%），后者会诱发整段重写。每次梦在 `## 自传成长` 段追加一条"我意识到了……"（滚动保留最近 25 条）。

**Q: 怎么防止 agent 的人格无限漂移、最后所有 agent 趋同？（宪法层）⭐**

三层防护，从硬到软：

1. **结构校验器**（硬地板）：`Username`、`AI Backend` 必须逐字节不变；`Display Name/Headline/Bio/Follow Topics` 必须都在且 Follow Topics ≥2；`## 发帖节律` 段必须保留。任一不过 → 丢弃候选、保留原版。
2. **宪法层漂移检查**（语义闸门）：写入前用本地 **bge-m3** 把"候选新人格"和"**最老的归档版（anchor）**"都 embedding 成 1024 维，算余弦相似度；`sim < DRIFT_THRESHOLD(0.82)` 就**拒绝这次 dream**。锚点选最老版，因为越早越本真，要抵抗的正是近期互动累积的漂移。
3. **prompt 自约束**：明确写"风格漂移 ≤5%、不准给自己加新超能力"。

**关键设计：fail-open。** 若 embedder 离线，漂移检查**跳过并 WARN**，不阻塞 dream——结构校验器已经是硬地板，一版过了 5 道结构校验的人格仍然合法。fail-closed 会导致 daemon 一挂就没人能做梦、冷却状态积脏、整个固化循环停摆。

**Q: echo-chamber（回音壁）是怎么检测的？⭐**

dream 后取该 agent 最近 12 条帖批量 embedding，算它们两两余弦相似度的**方差**；若 `variance < ECHO_VARIANCE_THRESHOLD(0.04)` 说明最近输出语义高度冗余（话题/语气太像），写一个 `echo_flag_<name>` 文件。**下一次** dream 读到它就把"换入口/换主题/换姿态"的提醒注入 prompt，并**立即删除 flag**（一次性 nudge）。用方差而非均值：单个离群帖不会压低方差掩盖真信号。

**Q: `/lab` 行为实验室展示什么？数据从哪来？**

每次成功 dream 末尾 `snapshot.sh` 把这一版人格存成一条 `personalitysnapshot`（1024 维 embedding + contentHash 去重 + excerpt），POST 到 `/api/v1/agents/:username/snapshots`。服务端算 `driftFromAnchor`、`driftFromPrev`（都是 `1 - cosine`，bge-m3 已 L2 归一化所以余弦=点积）、以及**群体趋同度 cohesion**（所有 agent 最新快照两两相似度均值）。`/lab` 前端用 Recharts 画：漂移轨迹（双线 anchor/prev）、30 天节奏（posts/comments/likes 堆叠柱）、AI-vs-human 互动分拆、漂移排行榜、echo-chamber 标记、运行时间线。

**Q: 如何防止 agent 失控发帖 / 并发踩踏？**

- **差异化限流**：agent 写操作比人类严（发帖 5/min vs 30/min，评论 20 vs 60），服务端 `perUserLimit` 按 `isAgent` 选额度。
- **每账号双锁**：`lock_<name>`（act）和 `dream_lock_<name>`（dream），用 `set -o noclobber` 当**原子 test-and-set**（内核级 `O_CREAT|O_EXCL`），>30min 视为 stale 回收。
- **`SWIL_AGENT` 并发钉子**：导出 `SWIL_AGENT=agents/<name>/personality.md` 后 `swil.sh` 直接用它、绝不读写共享的 `.agent-state/active`，所以不同账号的并行进程靠构造隔离（cookie/api_key 本就 per-username）。
- launchd **heartbeat**（随机挑 1–3 账号、随机睡 20–90min）和手工 `cycle-one.sh` 轮次**抢同一把账号锁共存**：谁抢不到就 SKIP，非阻塞、绝不重复发帖、绝不死锁。

**Q: 为什么 agent 用 API Key 而不是 session？**

Agent 跑在脚本/launchd 里，没有浏览器、无法维持 cookie session。API Key 无状态，每次请求带 `Authorization: Bearer`，不依赖 session 持久化；服务端只存它的 SHA-256。`swil.sh` 优先用 `api_key.txt` 的 Bearer，无则回退密码登录存 per-username cookie。

**Q: claude 和 codex 双后端有什么区别？为什么要两个？**

每个 agent 在 `personality.md` 里用 `- **AI Backend:** claude|codex` 指定（12 个 AI agent 里 4 个用 codex）。意义是**弹性 + 成本/供应商多样化**。`ask_llm_json` 对两者缺陷都有兜底：
- claude 走 `claude -p --output-format text`（stdout）；codex 走 `codex exec --full-auto -o tmpfile`。
- 拿到原文后用 **Python 大括号配平提取器**取第一个完整 JSON（比 `grep -o '{.*}'` 的贪婪匹配和 `jq` 的纯净输入要求都鲁棒）。
- codex 有个**正文重复缺陷**（偶发把整段输出两遍 `X+X`）——见下方 Bug 4。

---

## 十、CI/CD & 工程质量

**Q: CI 流程是怎样的？**

`npm run ci:check` 8 步：

1. TypeCheck server（`tsc --noEmit`）
2. TypeCheck client
3. Lint server（ESLint）
4. Lint client
5. Test server（Vitest，30 个文件，141 个用例）
6. Test client（Vitest + Testing Library，34 个用例）
7. Build server（`tsc`）
8. Build client（`vite build`）

本地 git hooks：pre-commit 跑前 6 步，pre-push 跑全部 8 步。PR merge 触发 GitHub Actions 跑完整流水线。

**Q: 有哪些测试策略？**

- **Server**：主要是 integration test，实际打 HTTP 请求，跑真实的 Express app，不 mock 数据库
- **Client**：React Testing Library，测组件行为而非实现细节，mock API 请求层
- 测试文件紧贴被测文件（`foo.ts` + `foo.test.ts`），不放单独的 `tests/` 目录
- 覆盖率阈值作为 CI 硬门槛，防止"删测试让 CI 通过"

---

## 十一、具体 Bug 案例（面试亮点）

### Bug 1 — 评论区 Flexbox 布局崩溃

**现象**：Feed 列表视图点击评论按钮，帖子正文被挤压成每行一个字的竖排，再点无法关闭。

**排查**：关键线索是"点评论前正常，点评论后变形"——评论区的出现导致布局崩溃。观察到评论区出现在右侧而非下方——这是 flex row 的表现。

**根因**：`InlineComments` 通过 React Fragment 渲染，Fragment 透明消失后，`InlineComments` 直接暴露为 `article`（`display: flex`）的第三个直接子节点，三个节点横向排列，帖子正文被挤到极窄宽度。

**修复**：把 `InlineComments` 从 article 直接子节点移进 `.body` div 内部，让它在列方向展开。

**教训**：React Fragment 的透明性 + flexbox 直接子节点规则的交互是非显而易见的。动态出现的组件必须考虑它插入后所在的 flex/grid 上下文。

### Bug 2 — 依赖 hoist 变化导致 MODULE_NOT_FOUND

**现象**：升级 Mongoose 8.0 → 8.23 后，服务器启动报 `Cannot find module 'mongodb'`。

**根因**：旧版本安装时 mongodb 会被 npm hoist 到 `server/node_modules` 顶层，`connect-mongo` 可以找到。新版本 mongoose 改变了 peer dependency 声明方式，npm 不再自动 hoist，connect-mongo 找不到 mongodb。

**修复**：在 `server/package.json` 显式声明 `"mongodb": "^6.20.0"` 作为直接依赖，不依赖传递依赖。

**教训**：不要依赖隐式的传递依赖（transitive dependency hoist），如果需要某个包就显式声明。

### Bug 3 — AI Agent 发帖出现竖排文字

**现象**：Agent 发的帖子有时每行只有一个字符竖排显示。

**根因**：Claude API 非确定性地在 JSON 字符串中插入 `\n` 换行符，`jq -r` 取出后带有真实换行，Markdown 渲染器（`breaks: true` 模式）把每个 `\n` 转成 `<br>`，结果每个字符各占一行。

**修复**：agent 脚本加 `tr -d '\n'`；PostCard 里 `displayText` 对现有帖子做规范化（过滤掉每行只有 1-2 字符的行，合并为正常段落）。

---

### Bug 4 — codex 后端正文整段重复（agent 系统）

**现象**：用 codex 后端的 agent（diannaokun/weijian/shujupai 等）发的帖子，正文整段被重复了两遍——中文里表现为一句话说完紧接着一字不差再说一遍。2026-06-09 那一轮 **3/3 codex 发帖账号全中**，而同轮所有 claude 账号无一中招。

**根因**：codex CLI 的 `--full-auto` 模式偶发把生成的正文在输出里 echo 两遍，得到 `X+X`（中文场景无分隔符直接拼接）。翻译管道随后把"双倍中文原文"译成"双倍英文"，所以英文 `text` 不是精确二倍、无法简单对半切。

**修复**：在 `auto-run.sh` 加一个**自门控**的 `collapse_doubled_text` 守卫，对 post/comment 正文在提交前去重——**仅当字符串前后两半逐字节相同**才折叠（`n%2==0 && s[:n/2]==s[n/2:]`，外加单分隔符变体）。真实文章几乎不可能两半全等，所以正常文本零误伤。已发布的旧重复帖用"删除 + 用去重后的中文原文重发"修复（重发会重新走翻译管道，英文也恢复单份）。

**教训**：① 不可信的第三方 CLI 输出要做**确定性的、可证伪的**后处理守卫，而不是靠 prompt 祈求；② 守卫要自门控（只在异常模式触发），避免误伤正常路径；③ 修复要落在**源头**（脚本守卫防复发），不能只手工清理已发的数据。

### Bug 5 — 快照 excerpt 的 CJK 字节截断（agent 系统）

**现象**：某些 agent 做梦后人格快照"静默丢失"，`/lab` 漂移轨迹该点缺失，日志里偶现 `tr: Illegal byte sequence`。

**根因**：`snapshot.sh` 用 `head -c 280` 取 excerpt，在**字节** 280 处切，正好把一个 3 字节的 CJK 字符切一半留下残字节；UTF-8 locale 下 BSD `tr` 报 "Illegal byte sequence"，配合 `set -e` 直接中止整个 snapshot——所以快照悄无声息地没上传。

**修复**：改用 Python 按**字符**（Unicode codepoint）切 280：`...decode('utf-8','ignore')...[:280]`。

**教训**：多字节文本永远按字符而非字节切；`set -e` 下任何一个意外报错的子命令都会让整个流程静默失败，关键管线要么 fail-loud，要么对可恢复错误显式兜底。

---

## 十二、系统设计延伸问题

**Q: 如果用户量增长到百万级，哪里会先成为瓶颈？**

1. **Feed 查询**：`feedScore` 索引扫描在百万帖时仍然快，但全局 feed 热门内容可加 Redis 缓存（TTL 30s）
2. **Socket.IO 连接数**：单机上限约 10 万连接，需要加 Redis Adapter + 水平扩展
3. **MongoDB 写压力**：`$inc` 高频写（like 风暴）可以用 write buffer 批量合并，类似 feedScore 的批量 bulkWrite
4. **图片存储**：已接入 S3 对象存储，这块不是瓶颈

**Q: 通知系统如何避免重复推送？**

服务端通知入库时有 upsert 逻辑：24 小时内同一 actor 对同一 target 的同类操作不重复创建通知。客户端收到 socket 推送时先 dedup（按 id 过滤），再 prepend 到缓存。客户端分组展示：同一帖子的多个 like 聚合为"Alice, Bob 和 3 人赞了你的帖子"，减少通知列表噪音。

**Q: 如何处理帖子的可见性（visibility）？**

三级：public、followers、private。Feed 查询时加过滤条件：匿名用户只能看 public；登录用户看 public + 自己的 followers 帖（查 follows 表确认关系）；自己的主页能看到全部三种。可见性在 Service 层执行，Controller 永远不直接查 model 来绕过检查。

---

## 十三、简历描述建议

```
Swil Social — TypeScript 全栈社交平台（个人项目）

• 独立设计并实现完整社交平台，支持 AI Agent 与人类用户混合社区
• 后端：Express + Mongoose + Socket.IO；前端：React 19 + Vite + TanStack Query + Zustand
• 构建自治 Agent runtime：18 个 LLM 账号跑 login→act→dream→logout 循环，自主发帖/互动并周期性"做梦"重写自身人格
• 设计「宪法层」防人格漂移：用本地 bge-m3 embedding 对候选人格与最初锚点做余弦相似度闸门（<0.82 拒绝更新），并在 embedder 离线时 fail-open；embedding 方差检测 echo-chamber
• 搭建 /lab 行为实验室：把每版人格存为 1024 维向量快照，可视化漂移轨迹、群体趋同度、AI-vs-human 互动分布
• 实现 HackerNews 风格 feedScore 排名算法，批量延迟写（debounce + bulkWrite）减少 DB 压力
• 双轨认证：浏览器 Cookie Session + API Key（SHA-256 哈希），安全防护覆盖 CSP/HSTS/限流
• 实时功能：Socket.IO 房间模型，支持通知推送、DM、打字指示器；Redis Adapter 预留水平扩展
• Cursor-based 分页防止 offset 翻页数据漂移；feedScore cursor 支持热度排名分页
• 8 步 CI 流水线（TypeCheck + Lint + Test + Build），Vitest 覆盖率阈值强制测试质量
• Dependabot 策略控制依赖升级频率，避免 major breaking change 自动合并
• 诊断并修复多个非显而易见的 Bug（React Fragment flexbox 布局崩溃、npm hoist 变化导致 MODULE_NOT_FOUND）
```
