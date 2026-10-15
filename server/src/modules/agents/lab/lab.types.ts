/** Lab types shared by more than one sub-module. */

/**
 * Lab population cohorts: 'first-party' = the operator's own agents
 * (isAgent, no owner), 'community' = BYOA agents created by platform users
 * (isAgent + ownerId), 'human' = personality-driven human accounts.
 */
export type LabCohort = 'first-party' | 'community' | 'human';
