# Shin Supplies Widget

Standalone Next.js app for the Shin Supplies CRM & Pipeline dashboard.
Self-contained widget + API — deploys as a single Vercel project, no
Railway/Express server required.

## Structure

- `public/dashboard.html` — the widget, embedded in Notion via an iframe
- `pages/api/crm-pipeline.js` — serverless function that queries Notion,
  computes the CRM stats, and returns JSON (ported from opxio-api's
  Express handler)
- `lib/cache.js`, `lib/queue.js` — in-memory cache + Notion request queue

## Deploy

1. Import this repo into Vercel as a new project.
2. Set environment variables (Project Settings → Environment Variables):
   - `NOTION_API_KEY` — your Notion integration token
   - `WIDGET_TOKEN` — any secret string; gates the API so the dashboard
     data isn't publicly scrapeable
   - `ENQUIRY_DB` / `PEOPLE_DB` — optional, only needed if you want to
     override the defaults (already set to the correct Shin Supplies DBs)
3. Deploy. Vercel auto-detects Next.js — no build config needed.
4. Embed `https://<your-vercel-domain>/dashboard.html?token=<WIDGET_TOKEN>`
   in the Notion page (embed block, not a link).

## Notes

- The in-memory cache in `lib/cache.js` only persists within a warm
  serverless instance — it's not the same always-on cache Railway gave you.
  Still cuts down repeat Notion calls during active use.
- DB IDs default to the verified-correct ones:
  - Enquiry Submissions — Shin Supplies: `71c9ba4af0694291876bf78422805f18`
  - Team (People): `34cfe60097f680e1bac0e75b431bc325`
