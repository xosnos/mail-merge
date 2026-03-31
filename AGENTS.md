<!-- Generated: 2026-03-26 | Updated: 2026-03-26 -->

# mail-merge

## Purpose
A Google Workspace Add-on that enables personalized bulk email campaigns from Google Sheets using Gmail drafts as templates. Users select a Gmail draft with `{{variable}}` placeholders, map columns from their spreadsheet, and send batch emails with open tracking, reply/bounce detection, scheduling, and a real-time analytics dashboard.

## Key Files

| File | Description |
|------|-------------|
| `README.md` | Project overview, features, setup instructions |
| `AGENT.md` | Developer-Agent workflow guidelines and phase tracking |
| `.gitignore` | Git ignore rules |
| `mail-merge-tracker-key.json` | Service account key for central tracker OAuth2 |
| `package.json` | Local dev scripts (e.g. `npm run push:addon`) |
| `jsconfig.json` | IDE autocomplete configuration |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Core add-on source code — UI, send engine, analytics (see `src/AGENTS.md`) |
| `docs/` | Product requirements, roadmap, deployment guides (see `docs/AGENTS.md`) |
| `central-tracker/` | Standalone tracking pixel web app for open detection (see `central-tracker/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- This is a Google Apps Script project using CLASP for local development
- The `src/` and `central-tracker/` directories are **separate Apps Script deployments** with their own `.clasp.json` and `appsscript.json`
- All backend code runs in Google Apps Script V8 runtime — no npm, no bundler, no modules (package.json is for local dev only)
- Functions must be top-level (global scope) to be callable from triggers, UI actions, or web app endpoints
- State is managed via `PropertiesService` and `CacheService`, not databases

### Testing Requirements
- Use `sendTestEmail()` to validate changes to the send pipeline before batch operations
- Verify tracking pixel flow end-to-end: send -> pixel hit -> cell update
- Check Gmail API quota limits when modifying send logic (daily quota ~100 for consumer, ~1500 for Workspace)

### Common Patterns
- Template variables use `{{VariableName}}` syntax with case-insensitive matching
- Campaign IDs follow format `camp_<sheetId>_<timestamp>`
- HMAC-SHA256 signatures secure tracking pixel URLs
- Time-driven triggers handle batch resumption and analytics scanning
- Card-based UI built with `CardService` for Workspace Add-on sidebar

## Dependencies

### External
- Google Apps Script runtime (V8)
- Gmail API (Advanced Service)
- Google Sheets API
- CLASP CLI for local development
- OAuth2 library (central tracker only)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
