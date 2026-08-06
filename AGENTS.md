<!-- Generated: 2026-06-06 | Updated: 2026-08-06 -->

# mail-merge

## Purpose

A Google Workspace Add-on that enables personalized bulk email campaigns from Google Sheets using Gmail drafts as templates. Users select a Gmail draft with `{{variable}}` placeholders, map columns from their spreadsheet, and send batch emails (immediately or scheduled for a future time) with open tracking, reply/bounce detection, and per-tab isolation.

## Project Structure & Subdirectories

| Directory          | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `src/`             | Core add-on source code — UI, send engine, analytics |
| `docs/`            | Product requirements, roadmap, deployment guides     |
| `central-tracker/` | Standalone tracking pixel web app for open detection |

---

## Directory-Specific Guidelines

### 1. Workspace Add-on (`src/`)

#### Purpose

Core source code for the Google Workspace Add-on. Contains the sidebar UI, email send engine, MIME builder, Gmail integration, analytics, and configuration management. This is the primary Apps Script deployment that users install.

#### Key Files

| File                       | Description                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/Main.js`             | Entry point — template validation (`validateTemplate`), sheet initialization (`initializeSheet`)                                                                      |
| `core/Config.js`           | Global configuration constants, PropertiesService/CacheService helpers, tracking & scheduling config                                                                  |
| `ui/CardUI.js`             | Workspace Add-on sidebar card builder — configuration form, action handlers, scheduled send status & controls                                                         |
| `services/GmailService.js` | Gmail API helpers — fetches drafts (with paginated loading), aliases, extracts `{{variables}}` from draft content                                                     |
| `services/SendEngine.js`   | Core batch send engine — variable substitution, dynamic CC/BCC, constant attachments, quota management, scheduled sends, timeout/resumption, tracking pixel injection |
| `utils/MimeBuilder.js`     | RFC 2822 MIME message builder — multipart support, inline images, attachments, base64 encoding                                                                        |
| `utils/Retry.js`           | Exponential backoff utility to gracefully handle Google API 429 errors (Quota/Rate Limits)                                                                            |
| `utils/ErrorLib.js`        | Dead-letter error logging for background processes (writes to hidden `_Logs` spreadsheet tab)                                                                         |
| `core/Analytics.js`        | Campaign analytics — bounce/reply detection via Gmail headers, background trigger setup                                                                               |
| `appsscript.json`          | Apps Script manifest — OAuth scopes, advanced services, add-on metadata                                                                                               |
| `.clasp.json`              | CLASP deployment config (script ID)                                                                                                                                   |

#### AI Agent Guidelines & Patterns

- **Global Scope**: All files share a single global scope — no `import`/`export`, no modules.
- **Top-Level Functions**: Functions called from `ui/CardUI.js` action handlers must be top-level (e.g., `handleSendEmails`, `handleTestEmail`, `handleScheduleSend`).
- **Config Keys**: `core/Config.js` centralizes all PropertiesService keys in `CONFIG.KEYS` — always use these constants, never hardcode key strings.
- **Tracking Secrets**: Tracking secrets are stored in PropertiesService (not in code) for security. `CONFIG.TRACKING` in `core/Config.js` holds the centralized tracker URL and references the secret key.
- **Resilient Execution**: All external calls (e.g. `Gmail.Users.Messages.send`) must be wrapped with `callWithBackoff()` from `utils/Retry.js` to ensure resilient execution.
- **Dead-letter logs**: Background triggers that crash should log via `ErrorLib.logError(err, context)` to provide diagnostic visibility in the `_Logs` spreadsheet tab.
- **Dev Mode**: Set `CONFIG.IS_DEV_MODE = true` in `core/Config.js` during local development to add a visual `[DEV]` tag to the UI. Ensure it is set to `false` before deploying a production release.
- **Testing**: Use `handleTestEmail()` to test the send pipeline with Row 2 data (forces CC/BCC to empty for testing security). After modifying `SendEngine.js`, verify: variable substitution, tracking pixel injection, timeout handling, batch resumption. Deploy with `clasp push` then test in a real Google Sheet.
- **Common Patterns**:
  - Event objects (`e`) from CardUI actions contain `formInputs` or `formInput` (handle both modern and legacy formats via `extractConfigFromEvent`).
  - Batch sends instantly execute in the background to bypass Add-on UI limits, using a 4.5-minute execution window with `ScriptApp.newTrigger` for auto-resumption.
  - Progress is cached in `CacheService` with `CONFIG.KEYS.PROGRESS_CACHE`.
  - Status column values follow patterns: `Email sent`, `Email opened`, `Replied`, `Bounced` (with timestamps in cells' comments/notes).
  - HMAC signatures use `Utilities.computeHmacSha256Signature` for tracking pixel URL security, appending `ts` (timestamp) and `tid` (Tracking ID, generated via `Utilities.getUuid()`).

#### Dependencies

- **Internal**: `central-tracker/` — receives tracking pixel hits and updates sheet cells.
- **External**:
  - Gmail API (Advanced Service) — draft access, raw message sending, header inspection.
  - Google Sheets API (Advanced Service) — read recipient data, write merge status, bulk row metadata queries.
  - `CardService` — Workspace Add-on UI framework.
  - `PropertiesService` / `CacheService` — state persistence.
  - `ScriptApp` — time-driven triggers for batch resumption, scheduled sends, and analytics.
  - `MailApp` — quota checking (`getRemainingDailyQuota`).
  - `Utilities` — HMAC, base64, UUID generation.

---

### 2. Central Tracker (`central-tracker/`)

#### Purpose

A standalone Google Apps Script web app that serves as the centralized open tracking endpoint. When an email recipient loads the invisible 1x1 tracking pixel, the browser hits this web app's `doGet()` endpoint, which validates the HMAC signature and updates the corresponding cell in the sender's spreadsheet to `Email opened`.

#### Key Files

| File              | Description                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `core/Tracker.js` | Main webhook handler — `doGet(e)` validates HMAC, authenticates via OAuth2 with domain-wide delegation, updates sheet cell |
| `appsscript.json` | Manifest — OAuth2 library dependency (v43), required scopes (spreadsheets, external_request), web app config               |
| `.clasp.json`     | CLASP deployment config for the tracker script                                                                             |

#### AI Agent Guidelines & Patterns

- **Separate Deployment**: This is a separate Apps Script deployment from `src/` — it has its own script ID, manifest, and deployment.
- **Execution Permissions**: The web app runs as the deploying user with `ANYONE_ANONYMOUS` access (no auth required for pixel hits).
- **Impersonation**: Uses OAuth2 library for domain-wide delegation to write back to the sender's spreadsheet.
- **Properties**: Script properties store sensitive config: `SERVICE_ACCOUNT_CLIENT_EMAIL`, `SERVICE_ACCOUNT_PRIVATE_KEY`, `SECRET_KEY`.
- **Security**: HMAC validation is critical for security — never bypass or weaken the signature check.
- **Testing**: Test the full tracking flow: send email with pixel -> open email -> verify cell updates to "Email opened" status. Verify HMAC validation rejects tampered URLs. Deploy with `clasp push` then publish as web app (Execute as: Me, Access: Anyone).
- **Common Patterns**:
  - URL parameters: `sheetId`, `sheetName`, `cell`, `user` (sender email), `ts` (timestamp for thresholding), `tid` (Tracking ID), `sig` (HMAC signature).
  - Only updates cell if current status is "Email sent" or "Email opened" (prevents overwriting "Replied" or "Bounced").
  - Uses `UrlFetchApp.fetch` with Sheets API v4 REST endpoint for cross-user sheet access. First searches for `tid` in the sheet notes, then falls back to `cell`.

#### Dependencies

- **Internal**:
  - `src/services/SendEngine.js` — injects the tracking pixel URL with HMAC signature into outgoing emails.
  - `src/core/Config.js` — `CONFIG.TRACKING` defines the tracker base URL and secret key reference.
- **External**:
  - OAuth2 for Apps Script library (ID: `1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF`, v43).
  - Google Sheets API v4 (REST, via `UrlFetchApp`).
  - `Utilities.computeHmacSha256Signature` — HMAC validation.

---

### 3. Documentation (`docs/`)

#### Purpose

Project documentation covering product requirements, technical roadmap, deployment procedures, and feature comparisons. These documents provide context for design decisions and implementation priorities.

#### Key Files

| File                         | Description                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ARCHITECTURE.md`            | Technical overview of the decoupled Apps Script deployments, state management, and MIME engine             |
| `UX_DESIGN.md`               | User journey, constraints of CardService, and interface logic                                              |
| `PRD.md`                     | Product Requirements Document — objectives, user personas, functional requirements, technical architecture |
| `ROADMAP.md`                 | Technical roadmap across 6 phases from project setup through UI polish                                     |
| `DEPLOYMENT.md`              | Step-by-step deployment guide — GCP setup, OAuth consent, CLASP config, Marketplace publishing             |
| `CENTRAL_TRACKING_SETUP.md`  | Setup guide for the centralized open tracking pixel system (service account, domain-wide delegation)       |
| `YAMM_FEATURE_COMPARISON.md` | Feature comparison matrix with Yet Another Mail Merge (YAMM)                                               |

#### AI Agent Guidelines & Patterns

- **Reference Scope**: These are reference documents — read them for context on design decisions and feature scope.
- **PRD**: `PRD.md` is the source of truth for feature requirements and user workflows.
- **Roadmap**: `ROADMAP.md` tracks implementation phases.
- **Modifications**: Update docs when implementing features that change documented behavior.

---

## Agent Workflow & Development Guidelines

### 1. Core Principles

- **Architect Before Coding:** Every new phase begins with a review of the PRD/ROADMAP, followed by an impact analysis, risk assessment, and a proposed architectural approach.
- **Alignment & Checkpoints:** Code is never generated until an `implementation_plan.md` is explicitly approved. Work is rigorously chunked into Phases.
- **Resiliency & Edge Cases:** We anticipate user errors (e.g., empty spreadsheets, malformed emails) with pre-flight checks before executing destructive operations (like `GmailApp.sendEmail`).

### 2. Development Stack & Tooling

- **Local Development CLI:** We use `@google/clasp` to develop locally using standard `.js`, `.html`, and `appsscript.json` files. Package management and scripts use `bun`. This bypasses the clunky online Apps Script editor and enables standard Git version control.
- **Architecture:** Vanilla HTML/CSS/JS frontend attached to a Google Apps Script backend using `HtmlService` and `CardService`.
- **Asynchronous Bridge:** `google.script.run` heavily utilized for all UI-to-Backend data fetching and execution.
- **State Persistence:** Google's `PropertiesService.getDocumentProperties()` safely stores user UI selections (Drafts, Columns, Aliases, Scheduled Sends) within the document's context.

### 3. Standard Operating Procedure (SOP)

For each new feature or roadmap phase:

1. **Planning:**
   - Agent synthesizes context, updates `task.md` with checklist items, and writes a detailed `implementation_plan.md`.
   - Agent halts execution to request manual code-review alignment.
2. **Execution:**
   - Upon "LGTM," Agent modifies `src/` files locally.
   - Agent runs `bun run format:write` to fix any formatting issues.
   - Agent runs `bun run lint` to lint the code.
   - Agent runs `bun test` to run the tests.
   - Agent automatically runs `bunx @google/clasp push -f` to push source code directly to the live Google Workspace instance.
   - Agent marks `task.md` checklist items as complete.
3. **Verification:**
   - Agent provides exact steps for the Developer to verify the changes inside the Google Sheet/Gmail ecosystem.
   - Developer confirms success or returns error stack traces for iterative fixing.

### 4. Phase Tracking

- **Phase 1 (Complete):** UI Scaffolding, `appsscript.json` OAuth Scopes, and Clasp login flow.
- **Phase 2 (Complete):** Gmail API Draft/Alias fetching, regex variable parsing, and automatic spreadsheet template initialization.
- **Phase 3 (Complete):** Core dispatch engine, quota tracking, dry-run test emails, pre-flight bad email syntax blocking. Refactored to Advanced Gmail API (`Gmail.Users.Messages.send`) with raw MIME messages via `src/utils/MimeBuilder.js`. Custom `X-Campaign-ID`, `X-Row-ID`, and `X-Tracking-ID` headers injected for tracking. Batch timeout management with immediate background scheduling (to bypass 30s UI limits) and automatic trigger-based resumption for large lists. Hidden/filtered rows in the UI are now seamlessly skipped. Dynamic CC/BCC columns are fully supported.
- **Phase 4 (Complete):** Tracking & Analytics Engine. Open tracking via pixel injection + `doGet` web app (with `ts` threshold for premature opens and `tid` Google Sheets API search). Reply tracking via `X-Campaign-ID` header scanning. Improved bounce detection with raw NDR header parsing. Unified `runAnalyticsScanner()` entry point. Background automation via time-driven triggers runs every 3 hours and is automatically enabled when sending a batch.
- **Phase 5 (Complete):** Advanced Automation, Performance Optimization & Production Readiness. Systems optimized for fast UI loading using bulk Sheets API query for hidden/filtered rows. Trigger resiliency achieved via `src/utils/Retry.js` (exponential backoff for Google API rate limits) and `src/utils/ErrorLib.js` (dead-letter queue logging for background triggers to an invisible `_Logs` sheet). Indefinite triggers replaced with a 7-day auto-expiry script context. Personalized Google Drive attachments were removed to resolve execution time limits.
- **Phase 6 (Complete):** UI/UX & Polish. Implemented template validation alerts, invalid email syntax row highlights, real-time progress caching/refresh widgets, paginated draft fetching, and restored Scheduled Sending with timezone guardrails, status cards, and cancellation controls within native CardService constraints. Follow-up campaigns remain as a future enhancement.
