# Centralized Open Tracking Setup Guide

This guide details the steps to set up centralized open tracking for the UNAVSA Mail Merge tool using a Google Cloud Service Account with Domain-Wide Delegation. 

This architecture allows the Mail Merge Add-on to automatically track "Opened" statuses for all users without requiring each user to deploy their own web app.

## Overview

1. **The Pixel:** The Mail Merge Add-on automatically injects a tracking pixel pointing to a Central Web App.
2. **The Webhook:** When the recipient opens the email, the image loads, pinging the Central Web App.
3. **The Impersonation:** The Central Web App uses a Google Cloud **Service Account** with Domain-Wide Delegation to impersonate the sender.
4. **The Update:** Using that impersonated access token, the Central Web App makes a REST API call to the Google Sheets API to update the sender's private spreadsheet, marking the specific row as "Opened".

---

## Phase 1: GCP Infrastructure Setup (Completed)

*The following steps have already been completed via the `gcloud` CLI in the `unavsa-mail-merge` project:*

1. Enabled required APIs: Google Sheets API (`sheets.googleapis.com`), Gmail API (`gmail.googleapis.com`), and Google Workspace Marketplace SDK (`appsmarket.googleapis.com`).
2. Created a dedicated Service Account: `mail-merge-tracker@unavsa-mail-merge.iam.gserviceaccount.com`.
3. Generated a JSON Key for the Service Account (saved locally as `mail-merge-tracker-key.json`).
4. Retrieved the Service Account Client ID: `104218562852483501818`.

---

## Phase 2: Google Workspace Admin Setup (Action Required)

You must authorize the new Service Account to act on behalf of your users. This requires Google Workspace Super Admin privileges.

1. Log in to the [Google Workspace Admin Console](https://admin.google.com).
2. Navigate to **Security > Access and data control > API controls**.
3. Scroll down to the bottom and click **Manage Domain Wide Delegation**.
4. Click **Add new**.
5. In the **Client ID** field, paste exactly: `104218562852483501818`
6. In the **OAuth scopes (comma-separated)** field, paste exactly: `https://www.googleapis.com/auth/spreadsheets`
7. Click **Authorize**.

---

## Phase 3: Central Tracker Web App Deployment

You need to deploy the code located in the `central-tracker/` directory as a standalone public Web App.

1. Go to [script.new](https://script.new) in your browser to create a new Google Apps Script project. Name it something like "UNAVSA Mail Merge Central Tracker".
2. Open the **Project Settings** (gear icon) and check the box to **"Show 'appsscript.json' manifest file in editor"**.
3. Go back to the Editor.
4. Copy the entire contents of `central-tracker/appsscript.json` from this repository and paste it into the `appsscript.json` file in your browser, replacing what is there. This links the necessary OAuth2 library.
5. Copy the entire contents of `central-tracker/core/Tracker.js` from this repository and paste it into `Code.gs` in your browser.
6. Open **Project Settings** (gear icon) and scroll down to **Script Properties**. Click **Add script property** and add the following three properties:
   * `SECRET_KEY`: A random string you define (e.g., `UNAVSA_TRACKER_SECRET_KEY_2024`).
   * `SERVICE_ACCOUNT_PRIVATE_KEY`: The exact contents of your `private_key` from the JSON file. Ensure you include the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` markers, and replace any literal `\n` with actual newlines if necessary.
   * `SERVICE_ACCOUNT_CLIENT_EMAIL`: The `client_email` from your JSON file (e.g., `mail-merge-tracker@unavsa-mail-merge.iam.gserviceaccount.com`).
7. Click **Deploy > New deployment**.
8. Click the gear icon next to "Select type" and choose **Web app**.
9. Set **Execute as** to **User deploying the web app (Me)**.
10. Set **Who has access** to **Anyone**.
11. Click **Deploy**.
12. **Copy the resulting Web App URL.**

---

## Phase 4: Add-on Configuration

Finally, you need to link the Mail Merge Add-on to your newly deployed Central Tracker Web App.

1. Open `src/core/Config.js` in the Mail Merge Add-on codebase.
2. Locate the `TRACKING` configuration block:
   ```javascript
   TRACKING: {
     CENTRAL_URL: 'YOUR_CENTRAL_WEB_APP_URL_HERE',
     SECRET_KEY: 'YOUR_SECRET_KEY_HERE'
   }
   ```
3. Replace `'YOUR_CENTRAL_WEB_APP_URL_HERE'` with the Web App URL you copied in Phase 3.
4. Replace `'YOUR_SECRET_KEY_HERE'` with the exact string you used for the `SECRET_KEY` Script Property in Phase 3.
5. Push your updated Add-on code to Google using `clasp push` (or your preferred deployment method).

Once deployed, the Add-on will automatically handle open tracking for all users seamlessly!