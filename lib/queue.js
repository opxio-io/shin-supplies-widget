// ─── lib/queue.js — shared Notion request queue ───────────────────────────
// Notion rate limit: ~3 req/sec. This queue caps concurrent Notion calls
// so we never hammer their API simultaneously within a single lambda.
// p-queue v8 is ESM-only.

import PQueue from 'p-queue'

export const notionQueue = new PQueue({ concurrency: 3 })
