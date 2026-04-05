<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-26 | Updated: 2026-03-26 -->

# src

## Purpose
Core source code for the Google Workspace Add-on. Contains the sidebar UI, email send engine, MIME builder, Gmail integration, analytics, and configuration management. This is the primary Apps Script deployment that users install.

## Key Files

| File | Description |
|------|-------------|
| `core/Main.js` | Entry point — template validation (`validateTemplate`), sheet initialization (`initializeSheet`) |
| `core/Config.js` | Global configuration constants, PropertiesService/CacheService helpers, tracking config |
| `ui/CardUI.js` | Workspace Add-on sidebar card builder — configuration form, analytics dashboard, action handlers |
| `services/GmailService.js` | Gmail API helpers — fetches drafts, aliases, extracts `{{variables}}` from draft content |
| `services/SendEngine.js` | Core batch send engine — variable substitution, quota management, timeout/resumption, tracking pixel injection |
| `utils/MimeBuilder.js` | RFC 2822 MIME message builder — multipart support, inline images, attachments, base64 encoding |
| `core/Analytics.js` | Campaign analytics — bounce/reply detection via Gmail headers, metrics aggregation, background trigger setup |
| `appsscript.json` | Apps Script manifest — OAuth scopes, advanced services, add-on metadata |
| `.clasp.json` | CLASP deployment config (script ID) |
| `.clasp.json.example` | Template for `.clasp.json` setup |

## For AI Agents

### Working In This Directory
- All files share a single global scope — no `import`/`export`, no modules
- Functions called from `ui/CardUI.js` action handlers must be top-level (e.g., `handleSendEmails`, `handleTestEmail`)
- `core/Config.js` centralizes all PropertiesService keys in `CONFIG.KEYS` — always use these constants, never hardcode key strings
- Tracking secrets are stored in PropertiesService (not in code) for security
- The `CONFIG.TRACKING` object in `core/Config.js` holds the centralized tracker URL and references the secret key
- **Dev Mode:** Set `CONFIG.IS_DEV_MODE = true` in `core/Config.js` during local development to add a visual `[DEV]` tag to the UI. Ensure it is set to `false` before deploying a production release.

### Testing Requirements
- Use `handleTestEmail()` to test the full send pipeline with Row 2 data
- After modifying `services/SendEngine.js`, verify: variable substitution, tracking pixel injection, timeout handling, batch resumption
- After modifying `utils/MimeBuilder.js`, verify: multipart structure, inline image CIDs, attachment encoding, custom headers
- After modifying `core/Analytics.js`, verify: bounce pattern matching, reply detection, metrics calculation
- Deploy with `clasp push` then test in a real Google Sheet

### Common Patterns
- Event objects (`e`) from CardUI actions contain `formInputs` or `formInput` (handle both modern and legacy formats via `extractConfigFromEvent`)
- Batch sends use a 4.5-minute timeout with `ScriptApp.newTrigger` for auto-resumption
- Progress is cached in `CacheService` with `CONFIG.KEYS.PROGRESS_CACHE`
- Status column values follow patterns: `Sent <timestamp>`, `Opened <timestamp>`, `Replied <timestamp>`, `Bounced <timestamp>`
- HMAC signatures use `Utilities.computeHmacSha256Signature` for tracking pixel URL security, appending `ts` (timestamp) and `tid` (Tracking ID, generated via `Utilities.getUuid()`).

## Dependencies

### Internal
- `central-tracker/` — receives tracking pixel hits and updates sheet cells

### External
- Gmail API (Advanced Service) — draft access, raw message sending, header inspection
- Google Sheets API — read recipient data, write merge status
- `CardService` — Workspace Add-on UI framework
- `PropertiesService` / `CacheService` — state persistence
- `ScriptApp` — time-driven triggers for batch resumption and analytics
- `MailApp` — quota checking (`getRemainingDailyQuota`)
- `Utilities` — HMAC, base64, UUID generation

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
