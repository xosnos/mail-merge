# Product Requirements Document: Internal Mail Merge Tool (YAMM Clone)

## 1. Executive Summary

This internal tool enables non-technical users to execute personalized mass email campaigns directly from Google Sheets using Gmail drafts as templates. It replicates the core functionality of Yet Another Mail Merge (YAMM), allowing users to map spreadsheet columns to email variables, configure sender details, and track engagement metrics (Sent, Opened, Replied, Bounced) in real-time within the spreadsheet.

## 2. Objectives & Success Metrics

* **Objective:** Provide a secure, cost-effective, and easy-to-use internal mail merge solution that keeps all proprietary data strictly within the company’s Google Workspace environment.
* **Success Metrics:**
  * High adoption rate among internal non-technical teams (e.g., Marketing, HR, Sales).
  * 100% accurate tracking of Sent, Opened, Bounced, and Replied statuses.
  * Zero compliance/security breaches (data never leaves the internal Google tenant).

## 3. User Personas

* **The Campaign Manager (End-User):** A non-technical employee who needs to send personalized emails to a list of recipients. They are comfortable with Google Sheets and Gmail but rely on an intuitive interface (like a sidebar) to connect the two.
* **The System Admin (You):** The developer deploying, maintaining, and updating the Google Apps Script project.

---

## 4. User Flow

1. **Draft Creation:** The user opens Gmail, composes a new message, adds variables like `{{First Name}}`, configures CC/BCC, and leaves it in their Drafts folder.
2. **Data Preparation:** The user opens the designated Google Sheet. Row 1 contains headers matching the variables in the draft (e.g., `First Name`, `Email`).
3. **Tool Initialization:** The user clicks the Add-on icon in the right-hand Google Workspace sidebar.
4. **Configuration:** In the sidebar, the user:
    * Selects the Gmail draft from a dropdown.
    * Inputs/selects "Sender Name", "Sender Email" (if they have aliases), and "Reply-To" email.
5. **Execution:** The user clicks "Send Emails".
6. **Tracking:** The script processes the rows, sends the emails, and automatically populates a "Merge Status" column in the sheet. Background triggers update this column over time with "Opened", "Replied", or "Bounced".

---

## 5. Functional Requirements

### 5.1 Email Templating (Gmail Integration)

* **Draft Retrieval:** The tool must fetch all current user drafts from Gmail and display their subject lines in a dropdown menu within the Sheets sidebar.
* **Variable Parsing:** The tool must identify variables enclosed in double curly brackets `{{ }}` within the Subject, Body (HTML and plain text), To, CC, and BCC fields of the draft.
* **Attachment Support:** Any attachments present in the Gmail draft must be carried over and sent with the merged emails.

### 5.2 Data Mapping & Execution (Google Sheets Integration)

* **Column Matching:** The tool must map column headers in the active sheet to the `{{variables}}` found in the selected draft. (e.g., Column `Email` maps to recipient).
* **Custom Menu & Sidebar:** An intuitive Google Workspace Add-on built with Google's CardService.
* **Sender Configuration:** The sidebar must allow the user to define:
  * **Sender Name:** A custom text string.
  * **Sender Email:** Must populate a dropdown of the user's authorized Gmail aliases.
  * **Reply-To:** A custom email address where replies should be directed.
* **Status Column:** The tool must automatically create a "Merge Status" column at the end of the data range to log the real-time status of each row.

### 5.3 Tracking & Analytics

The tool must accurately update the "Merge Status" column with the highest-achieved state in this hierarchy: *Sent -> Opened -> Replied*. (*Bounced* overrides all).

* **Sent:** Marked immediately upon successful execution of the Gmail API send request.
* **Opened:** Tracked via a 1x1 invisible tracking pixel (image) embedded at the bottom of the HTML email body.
* **Replied:** Tracked by querying the Gmail API for threads linked to the original sent Message-ID.
* **Bounced:** Tracked by parsing incoming emails for standard bounce/NDR (Non-Delivery Report) headers tied to the original Message-ID.

---

## 6. Non-Functional Requirements & Constraints

* **Google Workspace Limits:** The tool must account for Google's daily email sending quotas (typically 1,500 - 2,000 for Workspace accounts, 400 for trial/free). The UI should warn users if their list exceeds their daily quota.
* **Performance:** Sending a batch of emails should process quickly. If the list is massive (e.g., >500 rows), the script should utilize time-driven triggers to chunk the sending process and avoid the 6-minute Google Apps Script execution timeout.
* **Security:** Ensure the script runs *as the user executing the add-on* so emails are sent from their account and data access is restricted to their permissions.

---

## 7. Technical Architecture Recommendations (For the Developer)

* **Platform:** Google Workspace Add-on natively integrated into Google Sheets.
* **UI Framework:** Google Apps Script `CardService` for a native Material Design sidebar experience.
* **Sending Mechanism:** `GmailApp` or the Advanced Gmail API. *Note: Advanced Gmail API is highly recommended to easily manipulate headers (like `Message-ID` and `Reply-To`) and to inject the tracking pixel securely.*
* **Tracking Implementation:**
  * *Web App Deployment:* Deploy a standalone GAS Web App that listens for `GET` requests.
  * *Pixel Injection:* Append `<img src="YOUR_WEB_APP_URL?id=UNIQUE_ROW_ID" width="1" height="1" />` to the draft's HTML body.
  * *Webhook Handling:* When the pixel is loaded, the Web App receives the `id`, validates the HMAC signature, authenticates via a Service Account with Domain-Wide Delegation, locates the corresponding row in the Sheet, and updates the status to "Opened".
  * *Time-Driven Triggers:* Set up a background trigger (e.g., every 1 hour) that searches the user's inbox for replies (`in:inbox label:replied`) and bounces (`from:mailer-daemon`), matching them back to the Sheet via Message-IDs.

---

## 8. Future Enhancements (Post-MVP)

* **Test Email functionality:** Allow the user to send a test email to themselves before running the whole batch.
* **Scheduling:** Allow users to schedule the mail merge to run at a specific date/time.
* **Follow-up Campaigns:** Add the ability to automatically send a follow-up draft to users whose status remains "Sent" (not opened) after X days.
