# Feature Comparison: UNAVSA Mail Merge vs. YAMM

This document outlines the current feature set of the UNAVSA Mail Merge tool compared to Yet Another Mail Merge (YAMM), identifying key areas for future development to achieve feature parity.

## 1. High-Impact Missing Features (The "YAMM Classics")

- **Dynamic CC and BCC Support:**
  - _YAMM:_ Allows adding "CC" or "BCC" columns in the spreadsheet to dynamically copy different people on each row's email.
  - _Our Tool:_ This feature is now fully supported. The tool automatically detects "CC" and "BCC" columns in the sheet and dynamically injects them into the email headers for each row.
  - _Implementation Path:_ Achieved. `src/services/SendEngine.js` checks for "CC" and "BCC" columns and processes them alongside draft defaults.

- **Scheduled Sending:**
  - _YAMM:_ Allows users to pick a date and time to automatically send their mail merge.
  - _Our Tool:_ Fully supported. Built into CardUI with local timezone calculations, background trigger scheduling (`startScheduledBatchSend`), scheduled campaign status cards, and cancellation controls.
  - _Implementation Path:_ Achieved. `src/ui/CardUI.js` and `src/services/SendEngine.js`.

- **Follow-up Campaigns in the Same Thread:**
  - _YAMM:_ A massive selling point is the ability to easily send a follow-up draft (e.g., "Just bubbling this up!") _in the same email thread_ to people who didn't reply to the first batch.
  - _Our Tool:_ Listed as "Phase 5" in the Roadmap, but not yet implemented.
  - _Implementation Path:_ Build a UI for follow-ups, and a cron job to check the sheet for "Sent/Opened" statuses and automatically dispatch a new draft using the original `Message-ID` to thread it.

- **In-Sidebar Analytics Dashboard:**
  - _YAMM:_ The sidebar changes after a campaign is sent to show a live dashboard (often with a pie chart or percentage breakdown) of Open Rates, Bounce Rates, and Reply Rates.
  - _Our Tool:_ Removed from the UI sidebar to keep the interface simple and fast. Bounces, opens, and replies are still fully tracked and updated directly in the spreadsheet's "Merge status" column.
  - _Implementation Path:_ The background triggers and the tracking pixel handle spreadsheet updates; a sidebar-based metrics view can be restored from Git history if needed.

## 2. Advanced Tracking & Compliance Features

- **Click Tracking:**
  - _YAMM:_ Tracks when a recipient clicks a specific link in the email.
  - _Our Tool:_ We only track "Opens" via the invisible 1x1 pixel.
  - _Implementation Path:_ This would require the `src/services/SendEngine.js` to find all `href="..."` links in the HTML body and wrap them in a redirect URL pointing to the Central Tracker Web App, which logs the click and then redirects to the original destination.

- **1-Click Unsubscribe Management:**
  - _YAMM:_ Automatically appends an unsubscribe link. If clicked, the tool adds them to an internal "Do Not Send" list and skips them in future campaigns.
  - _Our Tool:_ Users would have to manage unsubscribes manually.
  - _Implementation Path:_ Add an "Unsubscribe" endpoint to the Central Tracker Web App. When clicked, it updates a dedicated "Unsubscribes" tab in the Google Sheet. The `src/services/SendEngine.js` checks this tab before sending.

## 3. Power-User Features

- **Personalized Attachments (via Google Drive):**
  - _YAMM:_ You can have an "Attachment" column in your sheet containing Google Drive links. YAMM fetches the file and attaches it to that specific person's email.
  - _Our Tool:_ Not supported. (The feature was implemented but subsequently removed because fetching individual Drive files row-by-row or in bulk caused execution timeouts and exceeded Google Apps Script limits).
  - _Implementation Path:_ Only constant attachments added directly to the Gmail draft template are supported.

- **Filter Rows / "Send to specific rows":**
  - _YAMM:_ You can use Google Sheets' native filter views to hide rows, and YAMM will only send to the visible rows.
  - _Our Tool:_ Fully supported. Hidden or filtered rows in your spreadsheet are natively skipped.
  - _Implementation Path:_ Achieved using Google Sheets API (`Sheets.Spreadsheets.get()`) to fetch hidden/filtered row metadata in a single request, optimizing execution time to milliseconds.
