# Codebase Audit Report: UNAVSA Mail Merge

## Overview
A comprehensive audit was performed on the UNAVSA Mail Merge project. The codebase is well-structured and makes excellent use of Google Apps Script APIs (especially the Advanced Gmail Service for precise MIME message creation and custom headers). The architecture is well-thought-out, particularly the 6-minute timeout management using time-based triggers and CacheService.

This report summarizes the findings, fixes applied, security review, and recommendations for publishing this as an internal Google Workspace Spreadsheet Add-on.

## Findings & Fixes Applied During Audit

1. **Bug Fixed: Reply Tracking Logic in `Analytics.js`**
   - **Issue:** The `checkReplies()` function was incorrectly matching replies. It iterated through threads and messages, and if it found the `X-Campaign-ID` header, it incorrectly assumed the *current message* being processed was the reply, which usually meant it identified the original sent message (from 'me') as the reply instead of the actual reply message from the recipient.
   - **Fix Applied:** Refactored `checkReplies()` into a two-pass system. Pass 1 checks the thread to see if *any* message has the campaign header. If it does, Pass 2 processes all messages in the thread that are *not* from the sender and properly flags them as replies in the spreadsheet.

2. **Bug Fixed: Open Tracking Web App Permissions in `appsscript.json`**
   - **Issue:** The webapp configuration in the manifest was set to `"executeAs": "USER_ACCESSING"` and `"access": "ANYONE"`. Because pixel tracking relies on an `<img>` tag loading a URL automatically from an email client, the request is completely unauthenticated. If set to `USER_ACCESSING`, Google will return a login page redirect instead of executing `doGet`, breaking the open tracking completely.
   - **Fix Applied:** Changed the webapp deployment configuration to `"executeAs": "USER_DEPLOYING"` and `"access": "ANYONE_ANONYMOUS"`.

## Security Review

1. **OAuth Scopes (`appsscript.json`)**
   - Currently, the app uses `https://mail.google.com/` which is the most permissive Gmail scope (Full Inbox Access). 
   - *Recommendation:* Since this is an internal Workspace Add-on, your Workspace administrators might allow this, but it's best practice to follow the principle of least privilege. You can try downgrading this to:
     - `https://www.googleapis.com/auth/gmail.send` (to send emails)
     - `https://www.googleapis.com/auth/gmail.readonly` (to read drafts, search for bounces/replies).
   - Other scopes (Spreadsheets, Script Container, etc.) are perfectly appropriate.

2. **Advanced Services**
   - You correctly use the Gmail Advanced Service (v1). Ensure that when deploying to GCP, the Gmail API is enabled in your Google Cloud Project.

## Performance & Scalability

1. **Timeout Management (`SendEngine.js`)**
   - **Excellent Implementation:** The script elegantly handles the Apps Script 6-minute execution limit by saving state (`PropertiesService`) after 4.5 minutes (`MAX_EXECUTION_MS = 270000`) and scheduling a `resumeBatchSend` trigger. 

2. **Analytics API Quota (`Analytics.js`)**
   - **Observation:** `checkReplies()` searches for `newer_than:7d` and makes a `Gmail.Users.Messages.get(..., {format: 'metadata'})` call for threads in the inbox. Since this runs every 15 minutes, if the user receives hundreds of emails a day, this could consume a significant amount of Google API Quota and execution time. 
   - *Recommendation:* Consider reducing the search window from `7d` to `1d` or `2d` in `checkReplies()` since the time-driven trigger runs frequently.

## Readiness for Publishing as a Workspace Add-on

To publish this internally to your organization, the codebase logic is ready, but the project configuration needs to be prepared for deployment.

1. **Google Cloud Project Setup:**
   - You must attach this script to a standard Google Cloud Project (not the default Apps Script project).
   - Ensure the "Gmail API" and "Google Workspace Marketplace SDK" are enabled in that GCP project.

2. **Manifest (`appsscript.json`) Updates:**
   - Currently, this script operates as a "Bound Script" or Legacy Editor Add-on via `onOpen` creating a custom menu.
   - **Option A (Legacy Editor Add-on):** You can publish it as-is. Users will install it, and the `UNAVSA Mail Merge` menu will appear under "Extensions".
   - **Option B (Modern Workspace Add-on):** Google highly recommends the newer "Workspace Add-ons" framework which uses the side panel and Card Service. However, since you have built a beautiful custom HTML UI (`Sidebar.html`), sticking to the Legacy Editor Add-on (Option A) is highly recommended because Workspace Add-ons **do not support** `HtmlService` (custom HTML/CSS), meaning you'd have to rewrite the entire UI using rigid Google Cards. 
   
3. **Web App URL Configuration:**
   - Remember that for open tracking to work, the user (or the admin) must deploy the project as a Web App (Deploy > New Deployment > Web App) and paste the resulting URL into the Sidebar. 

## Final Verdict
The codebase is exceptionally high quality. The use of raw MIME structures to inject custom tracking headers (`X-Campaign-ID`, `X-Row-ID`) is an advanced and highly robust way to track bounces and replies compared to standard subject-line matching. With the bugs fixed during this audit, **the tool is functionally solid and ready for internal deployment.**