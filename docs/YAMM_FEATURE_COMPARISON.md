# Feature Comparison: UNAVSA Mail Merge vs. YAMM

This document outlines the current feature set of the UNAVSA Mail Merge tool compared to Yet Another Mail Merge (YAMM), identifying key areas for future development to achieve feature parity.

## 1. High-Impact Missing Features (The "YAMM Classics")

*   **Dynamic CC and BCC Support:**
    *   *YAMM:* Allows adding "CC" or "BCC" columns in the spreadsheet to dynamically copy different people on each row's email.
    *   *Our Tool:* Currently, we only parse the CC/BCC fields saved in the *Gmail draft itself*, meaning everyone gets CC'd the same people.
    *   *Implementation Path:* Update `src/services/SendEngine.js` to check for "CC" and "BCC" columns in the sheet and inject those into the `buildMimeMessage` function.

*   **Follow-up Campaigns in the Same Thread:**
    *   *YAMM:* A massive selling point is the ability to easily send a follow-up draft (e.g., "Just bubbling this up!") *in the same email thread* to people who didn't reply to the first batch.
    *   *Our Tool:* Listed as "Phase 5" in the Roadmap, but not yet implemented.
    *   *Implementation Path:* Build a UI for follow-ups, and a cron job to check the sheet for "Sent/Opened" statuses and automatically dispatch a new draft using the original `Message-ID` to thread it.

*   **In-Sidebar Analytics Dashboard:**
    *   *YAMM:* The sidebar changes after a campaign is sent to show a live dashboard (often with a pie chart or percentage breakdown) of Open Rates, Bounce Rates, and Reply Rates.
    *   *Our Tool:* The user has to look at the "Merge status" column in the sheet. The sidebar just has a "Refresh Analytics" button.
    *   *Implementation Path:* Update `src/ui/CardUI.js` to parse the "Merge status" column and display a clean metric summary directly in the Add-on sidebar.

## 2. Advanced Tracking & Compliance Features

*   **Click Tracking:**
    *   *YAMM:* Tracks when a recipient clicks a specific link in the email.
    *   *Our Tool:* We only track "Opens" via the invisible 1x1 pixel.
    *   *Implementation Path:* This would require the `src/services/SendEngine.js` to find all `href="..."` links in the HTML body and wrap them in a redirect URL pointing to the Central Tracker Web App, which logs the click and then redirects to the original destination.

*   **1-Click Unsubscribe Management:**
    *   *YAMM:* Automatically appends an unsubscribe link. If clicked, the tool adds them to an internal "Do Not Send" list and skips them in future campaigns.
    *   *Our Tool:* Users would have to manage unsubscribes manually.
    *   *Implementation Path:* Add an "Unsubscribe" endpoint to the Central Tracker Web App. When clicked, it updates a dedicated "Unsubscribes" tab in the Google Sheet. The `src/services/SendEngine.js` checks this tab before sending.

## 3. Power-User Features

*   **Personalized Attachments (via Google Drive):**
    *   *YAMM:* You can have an "Attachment" column in your sheet containing Google Drive links. YAMM fetches the file and attaches it to that specific person's email.
    *   *Our Tool:* We only attach files that are attached to the original Gmail draft (meaning everyone gets the same attachment).
    *   *Implementation Path:* Update `src/services/SendEngine.js` to look for Drive URLs in an attachment column, fetch the `DriveApp.getFileById()` blobs, and pass them to the `MimeBuilder.js`.

*   **Filter Rows / "Send to specific rows":**
    *   *YAMM:* You can use Google Sheets' native filter views to hide rows, and YAMM will only send to the visible rows.
    *   *Our Tool:* We iterate through the raw data array. If a row has an email and an empty "Merge status", it gets sent, regardless of whether the row is hidden in the UI.
    *   *Implementation Path:* Update `SpreadsheetApp.getActiveSheet().getRange().getValues()` logic to skip rows where `sheet.isRowHiddenByUser(i)` is true.