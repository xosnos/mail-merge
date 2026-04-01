<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-26 | Updated: 2026-03-26 -->

# central-tracker

## Purpose
A standalone Google Apps Script web app that serves as the centralized open tracking endpoint. When an email recipient loads the invisible 1x1 tracking pixel, the browser hits this web app's `doGet()` endpoint, which validates the HMAC signature and updates the corresponding cell in the sender's spreadsheet to "Opened <timestamp>".

## Key Files

| File | Description |
|------|-------------|
| `core/Tracker.js` | Main webhook handler — `doGet(e)` validates HMAC, authenticates via OAuth2 with domain-wide delegation, updates sheet cell |
| `appsscript.json` | Manifest — OAuth2 library dependency (v43), required scopes (spreadsheets, external_request), web app config |
| `.clasp.json` | CLASP deployment config for the tracker script |

## For AI Agents

### Working In This Directory
- This is a **separate Apps Script deployment** from `src/` — it has its own script ID, manifest, and deployment
- The web app runs as the deploying user with `ANYONE_ANONYMOUS` access (no auth required for pixel hits)
- Uses OAuth2 library for domain-wide delegation to write back to the sender's spreadsheet
- Script properties store sensitive config: `SERVICE_ACCOUNT_CLIENT_EMAIL`, `SERVICE_ACCOUNT_PRIVATE_KEY`, `SECRET_KEY`
- HMAC validation is critical for security — never bypass or weaken the signature check

### Testing Requirements
- Test the full tracking flow: send email with pixel -> open email -> verify cell updates to "Opened <timestamp>"
- Verify HMAC validation rejects tampered URLs (wrong signature, missing params)
- Test OAuth2 domain-wide delegation with the service account
- Deploy with `clasp push` then publish as web app (Execute as: Me, Access: Anyone)

### Common Patterns
- URL parameters: `sheetId`, `sheetName`, `cell`, `user` (sender email), `sig` (HMAC signature)
- Only updates cell if current status is "Sent" (prevents overwriting "Replied" or "Bounced")
- Uses `UrlFetchApp.fetch` with Sheets API v4 REST endpoint for cross-user sheet access
- OAuth2 token refresh is handled by the OAuth2 library

## Dependencies

### Internal
- `src/services/SendEngine.js` — injects the tracking pixel URL with HMAC signature into outgoing emails
- `src/core/Config.js` — `CONFIG.TRACKING` defines the tracker base URL and secret key reference

### External
- OAuth2 for Apps Script library (ID: `1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF`, v43)
- Google Sheets API v4 (REST, via `UrlFetchApp`)
- `Utilities.computeHmacSha256Signature` — HMAC validation

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
