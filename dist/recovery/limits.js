/**
 * Longest Discord rate-limit wait a restore will sit through. A longer wait
 * stops the restore and saves a report instead, so it can be resumed later
 * (completed objects are reused). Kept under the 15 minute lifetime of an
 * interaction token.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 15 * 60 * 1000;
