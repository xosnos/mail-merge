## Technical Roadmap: Internal Mail Merge System

### Phase 1: Project Setup & Foundational Architecture

This phase establishes the workspace, permissions, and basic UI shell.

1. **Initialize the Environment:**
   - Create a Google Apps Script project for the Workspace Add-on.
   - Configure `appsscript.json` (the manifest) to include explicit OAuth scopes required for the project, including Sheets, Gmail send/modify, Drive, ScriptApp, and external request access.
2. **Build the UI Shell (CardService):**
   - Develop the Sidebar UI using the Google Workspace Add-on `CardService`. Create the navigation flow and the basic configuration form elements.
3. **Establish State Management:**
   - Set up a mechanism using `PropertiesService` with spreadsheet-scoped composite keys to store campaign settings (selected draft ID, sender alias, scheduled time) so the UI can retrieve the state if the user closes and reopens the sidebar without cross-sheet collisions.

### Phase 2: Gmail Integration & Templating Engine

This phase handles reading drafts and preparing the message content.

1. **Draft Retrieval System:**
   - Write a GAS function using `GmailApp.getDrafts()` to fetch all drafts.
   - Extract the Draft ID, Subject Line, and timestamp. Pass this to the frontend to populate the Draft Selection dropdown.
2. **Alias & Sender Configuration:**
   - Use `GmailApp.getAliases()` to populate the "Sender Email" dropdown.
   - Build UI inputs for "Sender Name" and "Reply-To" address.
3. **Variable Parsing Logic:**
   - Write a regex utility (e.g., `/\{\{(.*?)\}\}/g`) to scan the active draft’s Subject, HTML Body, Plain Text Body, CC, and BCC fields.
   - Write a validation function to compare the extracted `{{variables}}` against the current Sheet's column headers (Row 1) and alert the user in the UI if there are missing columns.

### Phase 3: The Core Send & Merge Engine (Including Test Emails) (Completed)

This phase is the heavy lifting of mapping data and dispatching emails.

1. **Build the "Test Email" Functionality:**
   - Create a function that takes the selected draft and maps it to a specific row (e.g., Row 2).
   - Send the parsed email _only_ to the active user's email address using the same MIME/Gmail API pipeline as the production send path.
2. **Develop the Batch Send Logic:**
   - Read the Sheet data as a 2D array.
   - Iterate through rows. For each row, replace the `{{variables}}` in the draft payload with the corresponding array index values.
   - Inject custom headers via the Advanced Gmail API (vital for tracking). Specifically, inject a custom `X-Campaign-ID` and `X-Row-ID` to easily tie replies and bounces back to a specific sheet row.
   - Optimize throughput by preparing bursts of messages, sending them in parallel with `UrlFetchApp.fetchAll`, buffering sheet writes, and applying campaign labels after send via `users.messages.modify`.
3. **Implement Quota & Timeout Management:**
   - Check `MailApp.getRemainingDailyQuota()` before initiating a run. Prevent execution if the list exceeds the quota.
   - Implement execution tracking. GAS scripts time out after 6 minutes. Store the `lastProcessedRow` in `PropertiesService`. If execution nears 5 minutes, gracefully halt and spawn a new time-driven trigger to resume the batch a minute later.
   - Scope all managed time-based triggers by spreadsheet ID so stale resume/background triggers do not accumulate across runs.

### Phase 4: Tracking & Analytics Engine

This phase requires setting up external listeners and inbox parsers.

1. **Deploy the Tracking Web App:**
   - Create a standalone Google Apps Script Web App (`central-tracker`).
   - **Domain-Wide Delegation:** Configure a Google Cloud Service Account and use the `OAuth2` Apps Script library to grant the Tracker the ability to write to the sender's sheet.
   - **Pixel Injection:** During the send loop (Phase 3), append an invisible 1x1 image to the HTML body pointing to the Tracker URL with HMAC-signed query parameters including `tid` (Tracking ID) and `ts` (Timestamp).
   - **Status Update:** When the Web App receives a ping, it validates the HMAC signature, ignores pings under a 10-second threshold from `ts`, locates the row via a Sheets API search for `tid` in cell notes, and updates the cell to `Email opened` even if the sender has not yet flushed `Email sent` to the sheet.
2. **Build the Inbox Scanner (Replies & Bounces):**
   - Write a function to scan the user's inbox using `GmailApp.search()`.
   - _For Replies:_ Search for emails in threads belonging to the campaign, or search by your custom `X-Campaign-ID` header. Ignore `mailer-daemon` replies.
   - _For Bounces:_ Search `from:mailer-daemon` and extract the original Message-ID or custom headers from the Non-Delivery Report.
   - Update the corresponding row in the Sheet. Ensure 'Bounced' statuses are never overwritten by 'Replied'.
   - **[Mitigated]:** Implement a mechanism to prevent tracking pixels from prematurely changing the merge status from 'Sent' to 'Opened' immediately after an email is dispatched. (Resolved via 10-second `ts` threshold in Tracker.js).
3. **Automate the Scanner:**
   - Create a time-driven trigger (currently every 3 hours) to run the Inbox Scanner in the background so the Sheet updates automatically, with spreadsheet-scoped cleanup to avoid trigger quota exhaustion.

### Phase 5: Advanced Automation & Production Readiness (Partially Completed)

This phase hardens the tool for enterprise use and adds scheduling.

1. **Build the Scheduling Mechanism:**
   - Add a Date/Time picker to the Sidebar UI.
   - When the user clicks "Schedule", save the campaign configuration to `PropertiesService`.
   - Use `ScriptApp.newTrigger().timeBased().at(dateObject).create()` to schedule the execution of the Phase 3 Batch Send logic.
2. **Implement Resiliency Patterns:**
   - Implement exponential backoff (`callWithBackoff`) around advanced Gmail API methods and Sheets reading/writing to survive 429 Too Many Requests errors.
   - Build a dead-letter error logging system (`ErrorLib.js`) to capture and write background trigger crashes to a hidden `_Logs` sheet.
3. **Architect Follow-up Campaigns (Pending):**
   - **UI Updates:** Add a "Follow-up" section in the sidebar. Users select a _second_ draft, a wait time (e.g., "3 days later"), and a condition (e.g., "If status is NOT Replied").
   - **State Tracking:** Create a hidden sheet or use `PropertiesService` to store a JSON object of active follow-up rules linked to the primary campaign.
   - **The Follow-up Cron Job:** Modify your background trigger (from Phase 4) to act as a daily cron job. Once a day, it evaluates the rows:
     - Did this row receive the initial email?
     - Has the wait time elapsed?
     - Does the status match the condition (e.g., Status == 'Opened' or 'Sent')?
     - If yes, trigger the send logic for the follow-up draft and update a new "Follow-up Status" column.

### Phase 6: UI/UX & Polish

1. **Real-Time Progress Feedback:**
   - Implement a progress bar in the Sidebar. As the backend processes rows, have the frontend poll a backend function every few seconds to retrieve the `currentProcessedRow` count and update the UI.
2. **Error Handling & Validation:**
   - Highlight invalid email formats in the Sheet before sending.
   - Provide clear error messages in the sidebar if the Web App URL isn't configured or if the user is out of quota.
