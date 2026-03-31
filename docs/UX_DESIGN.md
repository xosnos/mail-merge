# User Experience (UX) Design

This document maps out the user journey, constraints, and interface decisions for the UNAVSA Mail Merge Add-on, focusing on how a non-technical user interacts with the system.

## 1. User Persona & Goals

**The Campaign Manager (End-User)**
*   **Profile**: A non-technical employee (e.g., Marketing, HR, internal comms) who needs to send personalized emails to a list of recipients.
*   **Tools**: Comfortable with Google Sheets and Gmail.
*   **Goal**: Wants a seamless, "YAMM-like" experience directly within Google Workspace without having to export CSVs or use external software like Mailchimp.
*   **Pain Points**: Fear of making a mistake and sending the wrong email to the wrong person; lack of visibility into who actually read the email.

---

## 2. The User Journey

### 2.1 Entry Point
The tool is accessible directly where the data lives: Google Sheets.
*   The user opens a Google Sheet containing their mailing list.
*   They click the UNAVSA Mail Merge icon in the right-hand Google Workspace Add-on sidebar.
*   The system automatically reads the headers of the active sheet on load.

### 2.2 Configuration Flow
The interface is a vertical, card-based form (`src/ui/CardUI.js`) that guides the user through setup linearly.

1.  **Draft Selection**: The UI automatically fetches the user's most recent Gmail drafts. The user selects the draft they prepared as a template.
2.  **Sender Identity**:
    *   **Sender Name**: An optional text input to override the default name (e.g., "HR Team").
    *   **Sender Email**: A dropdown populated with the user's primary email and any authorized aliases.
    *   **Reply-To**: An optional field to direct replies to a different address.
3.  **Data Mapping**:
    *   The system requires knowing which column contains the recipient email addresses. The UI provides a dropdown populated by the current sheet's headers.

### 2.3 Validation & Safety
Before any bulk action occurs, the system provides several safety nets to build user confidence.

*   **Template Validation**: If the user's selected draft contains `{{First Name}}` but the sheet has a column named `First_Name`, the UI will surface a warning indicating missing columns.
*   **The "Test Email" Flow**: A dedicated "Send Test Email" button allows the user to send the merged version of Row 2 *only* to their own email address. This allows them to verify variable substitution and formatting before committing.
*   **Quota Warnings**: Google Workspace limits users to ~1500 emails per day. If the sheet has 2000 rows, the UI will warn the user that the batch will exceed their quota.

### 2.4 Execution & The "Invisible" UI
Once the user clicks "Send Batch", the heavy lifting happens asynchronously.

*   **Progress Indication**: While the backend processes rows, the UI polls `CacheService` to display real-time progress.
*   **The Merge Status Column**: The Add-on automatically appends a "Merge Status" column to the far right of the sheet data. As emails are sent, cells immediately populate with `Sent <timestamp>`.
*   **Zero-Interaction Tracking**: The true power of the UX is what happens *after* the sidebar is closed. The user does not need to log into a dashboard. As recipients interact with the emails, the "Merge Status" column automatically updates:
    *   `Sent` upgrades to `Opened <timestamp>` when the tracking pixel fires.
    *   `Opened` upgrades to `Replied` when the backend inbox scanner detects a reply.
    *   `Bounced` overwrites any status if a delivery failure is detected.

---

## 3. UI Design Constraints

Because the project uses the Google Workspace Add-on `CardService`, we are bound by specific UI constraints:
*   **No Custom CSS**: We cannot use arbitrary CSS or frameworks like Tailwind/Bootstrap. The UI strictly adheres to Google's Material Design component library.
*   **Widget Limits**: We are limited to standard inputs (Dropdowns, Text Inputs, Buttons).
*   **State Management**: Because the UI runs in an iframe and the backend is stateless, transitioning between views requires full page reloads via `ActionResponseBuilder.setNavigation()`.
