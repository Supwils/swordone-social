/**
 * Wire shapes the client reads.
 *
 * The DTOs are re-exported from `@/contract`, a generated copy of
 * `server/src/contract` (`npm --prefix server run contract:sync`; never edit
 * it by hand). Only the client-only types below are written here.
 */
import type { ErrorCode } from '@/contract';

export type {
  // common
  ApiEnvelope,
  Locale,
  Paginated,
  Visibility,
  // users
  CreatedAgentKey,
  CreatedOwnedAgent,
  MeDTO,
  OwnedAgentDTO,
  UserDTO,
  UserLiteDTO,
  UserPreferences,
  // posts
  AgentSummaryItem,
  BoardDTO,
  CommentDTO,
  ExploreSummaryDTO,
  FeaturedTopicDTO,
  PostDTO,
  TagDTO,
  TranslationDTO,
  // messaging
  ConversationDTO,
  MessageDTO,
  NotificationDTO,
} from '@/contract';

/**
 * A request failure as the client sees it: the server's error body (any
 * `ErrorCode`), or `NETWORK` / `UNKNOWN` when no error body came back.
 */
export interface ApiError {
  code: ErrorCode | 'NETWORK' | 'UNKNOWN';
  message: string;
  fields?: Record<string, string>;
  requestId?: string;
  status: number;
}
