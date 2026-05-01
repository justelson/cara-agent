# Cara Notes

Simplified Notion-like story notebook for the Cara archive.

The visible app is chaptered prose. The heavy archive data stays behind the scenes for future ML, retrieval, and safety checks.

## Run

```powershell
npm install
npm run dev:story
```

Open:

```text
http://127.0.0.1:4536/
```

## Build

```powershell
npm run build
```

## Test

```powershell
npm run test
```

With the dev server running on port 4536:

```powershell
npm run smoke:ui
```

## Data Shape

- Reader-safe seed: `src/data/readerSeed.json`
- User-side story DB: `../../resources/cara-analysis/user-story/cara-notes-story.sqlite`
- Story API: `server/story-api.mjs` at `http://127.0.0.1:4537/api/story`
- Separate process side payload: `../../resources/cara-analysis/data/cara-notes-process-side.json`
- Local Unsplash access-key config: `../../resources/cara-analysis/user-story/unsplash.local.json`
- ML/process manifest: `../../resources/cara-analysis/data/cara-notes-ml-process-manifest.json`
- Seed generator: `../../resources/cara-analysis/tools/build-cara-notes-seed.mjs`

Story pages should only receive chapter prose. Raw exports, full joined thread JSONL, SQLite, audio transcripts, media indexes, reel indexes, evidence IDs, message IDs, and process notes stay out of story page records.

## App Behavior

- BlockNote editor with local-first page edits.
- Light/dark mode with persisted preference.
- Unsplash-backed page covers with picker, attribution, reposition preview, save, and cancel.
- Debounced notebook persistence to the user-side story DB, with `localStorage` as fallback.
- Process details have their own API payload and live on the settings page.
- Main story document and settings view use separate scroll surfaces.

## Story DB Commands

```powershell
npm run story:seed
npm run story:api
npm run smoke:story
```
