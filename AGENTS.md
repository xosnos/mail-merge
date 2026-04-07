<!-- Generated: 2026-03-26 | Updated: 2026-03-26 -->

# mail-merge

## Purpose
A Google Workspace Add-on that enables personalized bulk email campaigns from Google Sheets using Gmail drafts as templates. Users select a Gmail draft with `{{variable}}` placeholders, map columns from their spreadsheet, and send batch emails with open tracking, reply/bounce detection, scheduling, and a real-time analytics dashboard.

## Key Files

| File | Description |
|------|-------------|
| `README.md` | Project overview, features, setup instructions |
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

## Agent Workflow & Development Guidelines

### 1. Core Principles
* **Architect Before Coding:** Every new phase begins with a review of the PRD/ROADMAP, followed by an impact analysis, risk assessment, and a proposed architectural approach.
* **Alignment & Checkpoints:** Code is never generated until an `implementation_plan.md` is explicitly approved. Work is rigorously chunked into Phases.
* **Resiliency & Edge Cases:** We anticipate user errors (e.g., empty spreadsheets, malformed emails) with pre-flight checks before executing destructive operations (like `GmailApp.sendEmail`).

### 2. Development Stack & Tooling
* **Local Development CLI:** We use `@google/clasp` to develop locally using standard `.js`, `.html`, and `appsscript.json` files. This bypasses the clunky online Apps Script editor and enables standard Git version control.
* **Architecture:** Vanilla HTML/CSS/JS frontend attached to a Google Apps Script backend using `HtmlService`.
* **Asynchronous Bridge:** `google.script.run` heavily utilized for all UI-to-Backend data fetching and execution.
* **State Persistence:** Google's `PropertiesService.getDocumentProperties()` safely stores user UI selections (Drafts, Columns, Aliases) within the document's context.

### 3. Standard Operating Procedure (SOP)
For each new feature or roadmap phase:
1. **Planning:**
   * Agent synthesizes context, updates `task.md` with checklist items, and writes a detailed `implementation_plan.md`.
   * Agent halts execution to request manual code-review alignment.
2. **Execution:**
   * Upon "LGTM," Agent modifies `src/` files locally.
   * Agent automatically runs `npx @google/clasp push -f` to push source code directly to the live Google Workspace instance.
   * Agent marks `task.md` checklist items as complete.
3. **Verification:**
   * Agent provides exact steps for the Developer to verify the changes inside the Google Sheet/Gmail ecosystem.
   * Developer confirms success or returns error stack traces for iterative fixing.

### 4. Phase Tracking
* **Phase 1 (Complete):** UI Scaffolding, `appsscript.json` OAuth Scopes, and Clasp login flow.
* **Phase 2 (Complete):** Gmail API Draft/Alias fetching, regex variable parsing, and automatic spreadsheet template initialization.
* **Phase 3 (Complete):** Core dispatch engine, quota tracking, dry-run test emails, pre-flight bad email syntax blocking. Refactored to Advanced Gmail API (`Gmail.Users.Messages.send`) with raw MIME messages via `src/utils/MimeBuilder.js`. Custom `X-Campaign-ID` and `X-Row-ID` headers injected for tracking. Batch timeout management with automatic trigger-based resumption for large lists.
* **Phase 4 (Complete):** Tracking & Analytics Engine. Open tracking via pixel injection + `doGet` web app (with `ts` threshold for premature opens and `tid` Google Sheets API search). Reply tracking via `X-Campaign-ID` header scanning. Improved bounce detection with raw NDR header parsing. Unified `runAnalyticsScanner()` entry point. Background automation via time-driven triggers (every 3 hours). Background scanning is automatically enabled when sending a batch.
* **Phase 5 (Partially Complete):** Advanced Automation. Scheduled sending via future time-driven triggers is implemented and configurable via a date-picker in the UI. Follow-up campaigns remain as a future enhancement.
