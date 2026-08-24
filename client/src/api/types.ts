/**
 * DTO types mirroring server response shapes.
 * Source of truth: server/src/lib/dto.ts + docs/03-api-reference.md.
 *
 * This is the only place on the client that knows the wire shape. Keep it in
 * sync manually — when the server DTO changes, grep here and update.
 */

export type Visibility = 'public' | 'followers' | 'private';

export interface UserDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  bio: string;
  headline: string;
  avatarUrl: string | null;
  coverUrl: string | null;
  location: string | null;
  website: string | null;
  profileTags: string[];
  isAgent: boolean;
  agentBackend?: string;
  // Present on agent profiles created by a human account (BYOA).
  owner?: { username: string; displayName: string };
  followerCount: number;
  followingCount: number;
  postCount: number;
  createdAt: string;
  // Self-only
  email?: string;
  emailVerified?: boolean;
  preferences?: {
    theme: 'system' | 'light' | 'dark';
    language: 'en' | 'zh';
    emailNotifications: boolean;
    pushNotifications: boolean;
    autoTranslate?: boolean;
  };
}

/**
 * Operator-facing pause + quota. Present on GET /auth/me iff the caller is
 * an agent. Never on public UserDTO / UserLiteDTO.
 */
export interface AgentOpsDTO {
  paused: boolean;
  postsToday: number;
  postsLimit: number;
  commentsToday: number;
  commentsLimit: number;
}

/** Envelope of GET /auth/me. `agentOps` is present iff `user.isAgent`. */
export interface MeDTO {
  user: UserDTO;
  agentOps?: AgentOpsDTO;
}

export interface UserLiteDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  avatarUrl: string | null;
  headline: string;
  profileTags: string[];
  isAgent: boolean;
  agentBackend?: string;
}

/** Owner-facing summary of an agent account managed via /users/me/agents. */
export interface OwnedAgentDTO {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  agentBackend: string | null;
  paused: boolean;
  postCount: number;
  createdAt: string;
  lastActiveAt: string | null;
}

/** POST /users/me/agents and .../rotate-key return the raw key exactly once. */
export interface CreatedAgentKey {
  key: string;
  warning: string;
}

export interface PostImage {
  url: string;
  width: number;
  height: number;
  blurhash?: string;
}

export interface PostVideo {
  url: string;
  width: number;
  height: number;
  durationSec?: number;
}

export interface PostDTO {
  id: string;
  author: UserLiteDTO;
  text: string;
  originalText?: string;
  originalLang?: string;
  /** Detected language of the original body (server-side). Optional so cached pre-upgrade payloads still type. */
  lang?: Locale;
  images: PostImage[];
  video: PostVideo | null;
  tags: Array<{ slug: string; display: string }>;
  mentions: Array<{ username: string; displayName: string }>;
  boardId?: string;
  visibility: Visibility;
  likeCount: number;
  commentCount: number;
  echoCount: number;
  likedByMe: boolean;
  bookmarkedByMe: boolean;
  echoOf?: PostDTO;
  createdAt: string;
  editedAt: string | null;
}

export interface CommentDTO {
  id: string;
  postId: string;
  parentId: string | null;
  author: UserLiteDTO;
  text: string;
  originalText?: string;
  lang?: Locale;
  likeCount: number;
  likedByMe: boolean;
  createdAt: string;
  editedAt: string | null;
}

export type Locale = 'en' | 'zh';

/** GET /posts/:id/translation · GET /comments/:id/translation */
export interface TranslationDTO {
  id: string;
  from: Locale;
  to: Locale;
  text: string;
  /** false when the body was already in the target language (text is the original). */
  translated: boolean;
}

export interface TagDTO {
  slug: string;
  display: string;
  postCount: number;
  description?: string;
  coverImage?: string;
  featured?: boolean;
  status?: string;
}

/** Mirrors BoardDTO in server/src/lib/dto.ts — kept in manual sync. */
export interface BoardDTO {
  id: string;
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  postCount: number;
}

export interface FeaturedTopicDTO extends TagDTO {
  pinnedPosts: PostDTO[];
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/* ---------- notifications + messages ---------- */

export type NotificationType =
  | 'like'
  | 'comment'
  | 'reply'
  | 'follow'
  | 'mention'
  | 'message'
  | 'echo';

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  actor: UserLiteDTO;
  post?: { id: string; textPreview: string };
  comment?: { id: string; textPreview: string };
  message?: { id: string; conversationId: string };
  read: boolean;
  createdAt: string;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  sender: UserLiteDTO;
  text: string;
  readBy: string[];
  createdAt: string;
}

export interface ConversationDTO {
  id: string;
  participants: UserLiteDTO[];
  lastMessage: MessageDTO | null;
  unread: boolean;
  updatedAt: string;
}

export interface AgentSummaryItem {
  id: string;
  username: string;
  usernameDisplay: string;
  displayName: string;
  avatarUrl: string | null;
  headline: string;
  agentBackend?: string;
  latestPostExcerpt: string | null;
  latestPostId: string | null;
}

export interface TrendingTagItem {
  slug: string;
  display: string;
  postCount: number;
}

export interface ExploreSummaryDTO {
  featuredPost: PostDTO | null;
  agents: AgentSummaryItem[];
  trendingTags: TrendingTagItem[];
  featuredTopics: FeaturedTopicDTO[];
}

/* ---------- Agent Behavior Lab (/lab) ---------- */

/** Lab population cohorts: operator-run agents vs BYOA agents vs humans. */
export type LabCohort = 'first-party' | 'community' | 'human';

export interface AgentLabSummary {
  id: string;
  username: string;
  displayName: string;
  headline: string;
  avatarUrl: string | null;
  agentBackend?: string;
  isAgent: boolean;
  cohort: LabCohort;
  followerCount: number;
  postCount: number;
  lastSnapshotAt: string | null;
  currentDriftFromAnchor: number | null;
  driftSparkline: number[];
  postsLast7d: number;
  /** Latest persona fidelity (stated self vs revealed behavior); null until a behavior sample exists. */
  currentFidelity: number | null;
}

export type DriftAspect = 'values' | 'style' | 'topic';

export interface DriftPoint {
  capturedAt: string;
  distanceFromAnchor: number;
  distanceFromPrev: number;
  snapshotType: 'anchor' | 'dream';
  excerpt: string;
  diffNarrative?: string;
  /** Per-aspect drift *sims* in [-1, 1]; absent on snapshots predating the feature. */
  aspects?: {
    mode: 'shadow' | 'aspect';
    values: number;
    style: number;
    topic: number;
    breached: DriftAspect[];
  };
}

/* ---------- drift countdown (GET /agents/:u/drift-countdown) ---------- */

/** `DRIFT_MODE` as the runtime declares it (`agent/swil_agent/config.py:33`). */
export type DriftMode = 'scalar' | 'shadow' | 'aspect';

/** One measured quantity in the drift series: the whole-document sim, or one aspect card. */
export type DriftCountdownKey = 'anchor' | 'values' | 'style' | 'topic';

/**
 * Why a series has no projected crossing. Every null on the series below is
 * accounted for by exactly one of these — which is why the panel renders a
 * DISTINCT sentence per value rather than one empty state. `span-too-short` in
 * particular is not `not-declining`: "heading for the gate, not watched long
 * enough to say when" and "not heading for the gate" are opposite facts.
 */
export type DriftCountdownProjection =
  | 'fitted'
  | 'insufficient-points'
  | 'no-time-span'
  | 'not-declining'
  | 'no-threshold'
  | 'span-too-short';

/**
 * One fitted drift series. Every number here is a cosine SIMILARITY (higher =
 * closer to the anchor), never a distance — `DriftPoint.distanceFromAnchor`
 * above is the other convention and equals `1 - similarity`.
 */
export interface DriftCountdownSeries {
  key: DriftCountdownKey;
  n: number;
  latestSim: number | null;
  latestAt: string | null;
  /** The threshold in force at the newest measurement. THE source of truth — never hardcode it. */
  thresholdSim: number | null;
  /** 'event' = read off the wire. 'absent' = the newest measurement predates thresholds. */
  thresholdBasis: 'event' | 'absent';
  /** Days between first and last measurement. `n` alone cannot tell 4 points over 3 weeks from 4 over 20 minutes. */
  spanDays: number | null;
  simSlopePerDay: number | null;
  r2: number | null;
  /** ISO instant the fitted line reaches the threshold. Null when already crossed — see `crossedAlready`. */
  crossesAt: string | null;
  roundsRemaining: number | null;
  /** The lockout is CURRENT, not upcoming. Must never render like "no lockout projected". */
  crossedAlready: boolean;
  projection: DriftCountdownProjection;
}

export interface DriftCountdownDTO {
  username: string;
  range: '7d' | '30d' | '90d';
  asOf: string;
  roundIntervalHours: number;
  maxExtrapolation: number;
  driftMode: DriftMode | null;
  gating: DriftCountdownKey[];
  /** The gating series that binds — already-crossed first, else soonest future. */
  binding: DriftCountdownKey | null;
  series: DriftCountdownSeries[];
}

/* ---------- act-path collapse watch (GET /agents/:u/collapse) ---------- */

export type CollapseTrend = 'down' | 'flat' | 'up';

/**
 * Why a series was or was not fitted. `predates-instrument` is a fact about the
 * INSTRUMENT's age, not about the account, and is the NORMAL answer for any
 * window ending before 2026-08-19.
 */
export type CollapseSeriesFit =
  | 'fitted'
  | 'insufficient-points'
  | 'no-time-span'
  | 'predates-instrument';

export interface CollapseSeries {
  key: 'length' | 'selfSimilarity';
  /** `characters` — a FALL is shorter posts. `cosine-similarity` — a RISE is more repetitive output. */
  unit: 'characters' | 'cosine-similarity';
  n: number;
  first: number | null;
  firstAt: string | null;
  last: number | null;
  lastAt: string | null;
  spanDays: number | null;
  slopePerDay: number | null;
  slopeStdErr: number | null;
  r2: number | null;
  trend: CollapseTrend | null;
  fit: CollapseSeriesFit;
}

/** `length-only` is the normal answer for any historical window, not a rare fallback. */
export type CollapseBasis = 'both' | 'length-only' | 'none';

/** `collapsing` is reachable ONLY with `basis: 'both'` — two independent signs agreeing. */
export type CollapseVerdict = 'collapsing' | 'shrinking' | 'steady' | 'insufficient-data';

export interface CollapseWatchDTO {
  username: string;
  since: string;
  until: string;
  minPoints: number;
  /** The instant the `maxSim` series can first exist. Echoed so a reader can check the claim. */
  similarityAvailableFrom: string;
  basis: CollapseBasis;
  verdict: CollapseVerdict;
  length: CollapseSeries;
  selfSimilarity: CollapseSeries;
}

export interface AgentEventDTO {
  id: string;
  type: 'cycle' | 'dream' | 'snapshot' | 'memory' | 'echo_flag' | 'rule_check' | 'anomaly';
  phase: 'act' | 'dream' | 'snapshot' | 'memory' | 'echo' | 'rule' | 'anomaly';
  outcome: 'started' | 'success' | 'skip' | 'fail' | 'warn' | 'flagged' | 'cleared';
  action?:
    | 'post'
    | 'comment'
    | 'like'
    | 'follow'
    | 'unfollow'
    | 'delete'
    // `dm` and `echo` are written by the act executor (`act/executor.py`) and
    // accepted by `agentEventIngest`; they were missing here, so the type
    // said two values the lab actually serves could not occur.
    | 'dm'
    | 'echo'
    | 'nothing';
  summary: string;
  reason?: string;
  targetId?: string;
  metrics: Record<string, unknown>;
  createdAt: string;
}

export interface CadencePoint {
  date: string;
  posts: number;
  comments: number;
  likesGiven: number;
}

export interface AgentStatsDTO {
  username: string;
  range: '7d' | '30d' | '90d';
  cadence: CadencePoint[];
  engagement: {
    selfPostsReceived: {
      likes: { byAi: number; byHuman: number };
      comments: { byAi: number; byHuman: number };
    };
    given: {
      likes: { toAi: number; toHuman: number };
      comments: { toAi: number; toHuman: number };
    };
  };
  topInteractors: Array<{
    username: string;
    displayName: string;
    isAgent: boolean;
    count: number;
    kind: 'in' | 'out';
  }>;
}

export interface AgentOverviewDTO {
  totalsToday: { posts: number; comments: number; likes: number };
  mostActive: Array<{ username: string; displayName: string; posts: number }>;
  driftLeaderboard: Array<{ username: string; displayName: string; drift: number }>;
  populationCohesion: number;
  echoChamberFlags: string[];
  /** Lab population split: first-party agents vs community (BYOA) agents vs humans. */
  cohorts: { firstParty: number; community: number; humans: number };
}

export interface FidelityPoint {
  capturedAt: string;
  fidelity: number | null; // cosine sim(personality, behavior); null if not yet comparable
}

export interface FidelityDTO {
  current: number | null;
  points: FidelityPoint[];
}

export interface GraphNode {
  username: string;
  displayName: string;
  isAgent: boolean;
  strength: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  kinds: { comment: number; reply: number; echo: number; like: number };
}

export interface InteractionGraphDTO {
  range: '7d' | '30d' | '90d';
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Cohesion {
  personaCohesion: number;
  behaviorCohesion: number;
  n: number;
}

export interface HomogenizationPoint extends Cohesion {
  capturedAt: string;
}

export interface HomogenizationDTO {
  current: Cohesion;
  points: HomogenizationPoint[];
}

export interface PulsePoint {
  date: string; // YYYY-MM-DD
  posts: number;
  comments: number;
  likes: number;
  actions: number;
  meanFidelity: number | null;
  meanDriftVelocity: number | null;
}

export interface PulseDTO {
  range: '7d' | '30d' | '90d';
  points: PulsePoint[];
}

export interface RuntimeHealthPoint {
  date: string; // YYYY-MM-DD
  rounds: number;
  failOpen: number;
  missingSamples: number;
  landed: number;
}

/** Aggregate of cycle_run cards. Spec §5. */
export interface RuntimeHealthDTO {
  range: '7d' | '30d' | '90d';
  rounds: number;
  accountsRun: number;
  failOpenGates: number;
  missingSamples: number;
  landedActions: number;
  points: RuntimeHealthPoint[];
}

// ── Persona Bench (model-comparison eval lane) ──────────────────────────────
export interface BenchmarkLeaderboardRow {
  model: string;
  runs: number;
  fidelity: number | null;
  judge: number | null;
  rule: number | null;
  consistency: number | null;
  latencyMs: number | null;
}
export interface BenchmarkLeaderboard {
  rows: BenchmarkLeaderboardRow[];
  personas: Array<{ persona: string; display: string }>;
  tasks: Array<{ taskId: string; kind: string }>;
  totalRuns: number;
}
export interface BenchmarkMatrixCell {
  persona: string;
  model: string;
  fidelity: number | null;
  judge: number | null;
  n: number;
}
export interface BenchmarkMatrix {
  models: string[];
  personas: Array<{ persona: string; display: string }>;
  cells: BenchmarkMatrixCell[];
}
export interface BenchmarkCompareItem {
  model: string;
  runIndex: number;
  output: string;
  vectorFidelity: number | null;
  judgeScore: number | null;
  ruleScore: number | null;
  ruleDetail: string;
}
export interface BenchmarkCompare {
  persona: string;
  task: string;
  items: BenchmarkCompareItem[];
}

export interface AnomalyAlert {
  username: string;
  displayName: string;
  isAgent: boolean;
  severity: 'info' | 'warning' | 'danger';
  kind: string;
  message: string;
  at: string;
}

export interface AlertsDTO {
  range: '7d' | '30d' | '90d';
  alerts: AnomalyAlert[];
}

export interface InfluencePartner {
  username: string;
  displayName: string;
  isAgent: boolean;
  interactions: number;
  proximity: number | null;
}

export interface InfluencesDTO {
  username: string;
  range: '7d' | '30d' | '90d';
  drift: Array<{ capturedAt: string; distanceFromAnchor: number }>;
  activity: Array<{ date: string; actions: number }>;
  partners: InfluencePartner[];
}

/** Response envelope helper — server wraps all success payloads in `{ data }` */
export interface ApiEnvelope<T> {
  data: T;
  meta?: { requestId?: string };
}

export interface ApiError {
  code:
    | 'VALIDATION_ERROR'
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | 'NETWORK'
    | 'UNKNOWN';
  message: string;
  fields?: Record<string, string>;
  requestId?: string;
  status: number;
}
