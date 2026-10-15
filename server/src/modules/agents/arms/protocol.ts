/**
 * The pre-registered numbers of Era 3 (pre-registration + amendment 1). One
 * place, so the report, its tests and the client copy cannot disagree.
 */

/** Completed rounds that close the confirmatory window. */
export const TARGET_ROUNDS = 12;
/** Completed window rounds with data an arm needs to qualify. */
export const MIN_ARM_ROUNDS = 9;
/** Accounts with a statistic an arm needs to qualify. */
export const MIN_ARM_ACCOUNTS = 2;
/** Roster `cycle_run` cards that make a sweep round completed. */
export const COMPLETED_MIN_CARDS = 10;
/** Distinct sweep rounds with posts that (a)/(c) account slopes need. */
export const MIN_SLOPE_ROUNDS = 3;
/** Measured candidates that a (b) account statistic needs. */
export const MIN_REPETITION_CANDIDATES = 4;
/** Candidates at or above the threshold the window needs before (b) can decide. */
export const MIN_HIGH_CANDIDATES = 5;
/** The duplicate guard's threshold; (b) reads only rows measured against it. */
export const DUPLICATE_THRESHOLD = 0.92;
