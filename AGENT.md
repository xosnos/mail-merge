# Agent Workflow & Development Guidelines

This document outlines the collaborative engineering workflow established for the Mail Merge project between the Developer and the Agent.

## 1. Core Principles

* **Architect Before Coding:** Every new phase begins with a review of the PRD/ROADMAP, followed by an impact analysis, risk assessment, and a proposed architectural approach.
* **Alignment & Checkpoints:** Code is never generated until an `implementation_plan.md` is explicitly approved. Work is rigorously chunked into Phases.
* **Resiliency & Edge Cases:** We anticipate user errors (e.g., empty spreadsheets, malformed emails) with pre-flight checks before executing destructive operations (like `GmailApp.sendEmail`).

## 2. Development Stack & Tooling

* **Local Development CLI:** We use `@google/clasp` to develop locally using standard `.js`, `.html`, and `appsscript.json` files. This bypasses the clunky online Apps Script editor and enables standard Git version control.
* **Architecture:** Vanilla HTML/CSS/JS frontend attached to a Google Apps Script backend using `HtmlService`.
* **Asynchronous Bridge:** `google.script.run` heavily utilized for all UI-to-Backend data fetching and execution.
* **State Persistence:** Google's `PropertiesService.getDocumentProperties()` safely stores user UI selections (Drafts, Columns, Aliases) within the document's context.

## 3. Standard Operating Procedure (SOP)

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

## 4. Current Phase Tracking

* **Phase 1 (Complete):** UI Scaffolding, `appsscript.json` OAuth Scopes, and Clasp login flow.
* **Phase 2 (Complete):** Gmail API Draft/Alias fetching, regex variable parsing, and automatic spreadsheet template initialization.
* **Phase 3 (Complete):** Core dispatch engine, quota tracking, dry-run test emails, pre-flight bad email syntax blocking. Refactored to Advanced Gmail API (`Gmail.Users.Messages.send`) with raw MIME messages via `MimeBuilder.js`. Custom `X-Campaign-ID` and `X-Row-ID` headers injected for tracking. Batch timeout management with automatic trigger-based resumption for large lists.
* **Phase 4 (Complete):** Tracking & Analytics Engine. Open tracking via pixel injection + `doGet` web app. Reply tracking via `X-Campaign-ID` header scanning. Improved bounce detection with raw NDR header parsing. Unified `runAnalyticsScanner()` entry point. Background automation via time-driven triggers (every 2 hours). Sidebar UI updated with background scanning toggle.
