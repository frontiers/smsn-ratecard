# CLAUDE.md — Samansamnuek Creator Proposals

Context for Claude Code working in this repo.

## What this is
A small Node/Express app that hosts creator-campaign proposals for the Samansamnuek agency (Futureboard, Narukkrub, JohankunTCG and other channels).
- `/admin` — password-protected backend. Team edits rates, formulas, discounts, channels, CI and quotation details.
- `/p/<slug>` — client-facing, read-only proposal. Clients can toggle channels/phases to see package prices and export text/xlsx/csv/PDF quotation.

UI copy is Thai. Keep new UI text in Thai, short and plain.

## Layout
- `server.js` — routes, security headers (CSP), admin API, public API. Mounted under `BASE_PATH`.
- `src/auth.js` — single admin password (scrypt hash or plain env), HMAC-signed session cookie, login throttle.
- `src/store.js` — one JSON file per proposal in `DATA_DIR/proposals/<id>.json`: `{id, slug, title, published, createdAt, updatedAt, state}`. Atomic writes; delete = move to `trash/`. Optimistic concurrency via `baseUpdatedAt` (409 on conflict).
- `src/publicView.js` — **the security boundary**: builds the client payload from `state`. Pre-computes `channel.itemRate`, `channel.phaseTotal` (overrides) and `channel.extraAmt` (opportunity) and strips `itemTypes[].ratio/floor/note`, `channels[].rates/override`, channels with `on:false`, extras notes and opportunity inputs. Any new state field is private by default; add it to the `pick()` lists only if the client page needs it.
- `public/assets/app.js` — one front-end for both pages (`<body data-mode="admin|client">`). Sections: state utils → pricing (`calc`, `quote`, `phaseSummary`) → site render → admin drawer tabs → events → server API → exports (copy text, TSV, xlsx, csv, quotation PDF via html2canvas+jsPDF) → login/list → boot.
- `public/assets/app.css` — CI: black/white with Futureboard greys (#717171, #A2A3A2), square corners, Barlow Condensed + Kanit display, IBM Plex Sans Thai body. Brand colours/fonts/logos are also editable per proposal (Backend → แบรนด์ & บริษัท) and applied via CSS variables in `applyBrand()`.
- `seed/rov-10th.json` — template used for "new proposal" and first run (RoV 10th anniversary campaign for Hepmil / Garena).
- `test/api.test.js` — `npm test` (node:test, no extra deps).

## Pricing model (keep client and server in sync)
- **Rate card** `state.itemTypes[]` `{id,label,unit,ratio,floor,included,note}`: price for a channel = `channel.rates[id]` if set, else `max(ratio × channel.price, floor)` rounded to `settings.roundTo`; `included:true` → 0 (e.g. event day / tournament day, already covered by the clip fee because the team + MC go on site anyway).
- **Phases** `state.phases[].items[]` `{type,label,qty,rush}`: any number of items per phase; phase price per channel = Σ rate × qty. `rush` adds `channel.rush × qty` as "ค่าเร่งงาน" (not discounted). `channel.override[phaseId]` replaces the phase price.
- Bundle discount (`settings.bundlePct`) when a channel takes every phase; tier discount by number of selected channels, on content only.
- **Extras** `state.extras[]`:
  - `dealPct` / `dealFixed` — charged **once per deal after discounts** (brand protection e.g. MLBB 20%, asset buy-out 50%). Base = content after bundle + tier discounts.
  - `fixed` / `perPhase` / `opportunity` — once per channel. `opportunity` = clip price × same-category jobs per month × months × likelihood % (a way to estimate brand protection from lost work; usually 1–2 same-category videos/month).
- Implemented in `app.js` (`autoRate`, `phaseCalc`, `calc`, `quote`, `phaseSummary`, `chExtraAmt`) and `src/publicView.js` (`rateFor`, `extraAmtFor`). Client pages receive `c.itemRate`, `c.phaseTotal`, `c.extraAmt` precomputed so ratios/floors/overrides/notes never leave the server. Change both sides together and extend the leak test.
- `migrate()` in app.js converts proposals saved in the old format (phase `comps`, extras `rush`/`pct`).

## Conventions
- No build step; plain browser JS. Keep it that way unless asked.
- No inline event handlers or inline scripts (CSP `script-src 'self'`). Inline styles are allowed.
- Never send private fields to `/api/public/*`; extend `test/api.test.js` when adding fields.
- Images (logos/avatars) are stored as small data URLs inside the proposal state (resized client-side in `readImage`). If storage grows, move them to files under `DATA_DIR/uploads` and serve them statically.
- Run `npm test` after changes.

## Possible next steps
- Per-user accounts (replace shared password) and an audit log of saves.
- Optional per-proposal client password.
- SQLite instead of JSON files if the proposal count grows into the hundreds.
