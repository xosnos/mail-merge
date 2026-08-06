# UNAVSA Mail Merge: Deployment Guide

This guide covers the necessary steps to deploy the UNAVSA Mail Merge tool as an internal Google Workspace Add-on for `unavsa.org`.

## Phase 1: Create a Standalone Apps Script Project

Because the Add-on is designed to be installed from the Workspace Marketplace and used across many spreadsheets, it MUST be deployed from a standalone script project, NOT a script bound to a specific Google Sheet.

1. Navigate to [script.google.com](https://script.google.com/).
2. Click **New project** in the top left.
3. Name the project "UNAVSA Mail Merge Add-on".
4. Copy the new **Script ID** from the Project Settings (gear icon).
5. Update the `.clasp.json` file in your local repository with this new `scriptId`.
6. Run `bun run push:addon` (or `clasp push` inside `src/`) to upload the add-on code to the new standalone project.

## Phase 2: Google Cloud Project (GCP) Configuration

These steps must be performed by a Google Workspace Admin with access to Google Cloud.

### 1. Create a Standard GCP Project

1. Navigate to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., "UNAVSA Mail Merge").
3. Ensure the project is associated with your `unavsa.org` organization.

### 2. Enable Required APIs

In the GCP Console for your new project:

1. Go to **APIs & Services > Library**.
2. Search for and enable the **Gmail API**.
3. Search for and enable the **Google Workspace Marketplace SDK**.

### 3. Configure OAuth Consent Screen

1. Go to **APIs & Services > OAuth consent screen**.
2. Select **Internal** user type (this restricts access to only users within `unavsa.org`) and click **Create**.
3. Fill in the required app information (App name, support email, etc.).
4. Under the **Scopes** step, click **Add or Remove Scopes**. You need to manually add the scopes defined in the `appsscript.json` file:
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/script.send_mail`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/script.container.ui`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/script.scriptapp`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/script.external_request`
5. Save and continue through the summary screen.

### 4. Link Apps Script to GCP Project

1. Find your **Project Number** in the GCP Console (on the Project Info panel of the dashboard).
2. Open the Apps Script Editor for your Mail Merge project.
3. Click the gear icon (**Project Settings**) on the left.
4. Under **Google Cloud Platform (GCP) Project**, click **Change project**.
5. Enter the Project Number from step 1 and click **Set project**.

---

## Phase 3: Deployment & Publishing

### 1. Deploy the Central Tracker (For Open Tracking)

The Central Tracker Web App needs to be deployed so the pixel tracking system has a URL to receive data. This is done ONCE for the whole organization.

1. Follow the [Central Tracker Setup Guide](./CENTRAL_TRACKING_SETUP.md) to deploy the central tracker script and obtain its URL.
2. Update the Add-on's Script Properties (`TRACKING_CENTRAL_URL` and `TRACKING_SECRET_KEY`) with the deployed Tracker details.
3. Push the add-on code using `bun run push:addon`.

### 1.5 Manifest URL Fetch Allowlist

The add-on now sends mail and applies campaign labels through direct Gmail REST calls as well as Drive media fetches. Keep the `urlFetchWhitelist` in `src/appsscript.json` aligned with the current runtime behavior before deployment:

- `https://www.googleapis.com/drive/v3/files/`
- `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`
- `https://gmail.googleapis.com/gmail/v1/users/me/messages/`

### 2. Publish the Workspace Add-on

1. **CRITICAL:** Open `src/core/Config.js` and ensure `IS_DEV_MODE` is set to `false`. If you forget this, all store users will see a `[DEV]` tag on their add-on. Push the add-on code using `bun run push:addon` if you made changes. Alternatively, run `bun run deploy` to push and deploy both tracker and add-on (if using the `@HEAD` central tracker endpoint; if using versioned tracker web app deployments, copy the newly created web app URL into `TRACKING_CENTRAL_URL` before pushing the add-on).
2. Go back to your Google Cloud Console.
3. Navigate to **APIs & Services > Google Workspace Marketplace SDK**.
4. Go to the **App Configuration** tab.
5. Select **Google Sheets add-on**.
6. Provide the **Script ID** or **Deployment ID**. Found in Project Settings.
7. Under the **Store Listing** tab, fill out all required fields (Name, Short description, Category, Graphics/Logos).
8. Use the UNAVSA logo for the icon: `https://media.unavsa.org/uploads/2021/03/cropped-UNAVSA-Logo-original.png`.
9. Set the application visibility to **Private** (so it only publishes to `unavsa.org` users).
10. Click **Publish**.

### 3. Installation

Once published privately, users within your organization can install it:

1. Open a Google Sheet.
2. Click **Extensions > Add-ons > Get add-ons**.
3. Search for "UNAVSA Mail Merge" or navigate to the "Internal Apps" section of the marketplace.
4. Install the Add-on. It will appear on the right-side panel when opening Google Sheets.

## Troubleshooting

### `Error 401: deleted_client`

If authorization suddenly fails with `deleted_client`, the OAuth client attached to the Apps Script project's linked Google Cloud project was deleted.

1. Open Google Cloud Console and go to **Google Auth Platform > Clients > Deleted credentials**.
2. Restore the deleted client if it is still within the recovery window.
3. If it cannot be restored, open the Apps Script project, go to **Project Settings**, temporarily switch the linked GCP project, then link the intended project again to recreate the Apps Script-managed OAuth client.
4. Re-run authorization after the client is restored or recreated.

### Tracker code updated but open tracking still uses old behavior

If `TRACKING_CENTRAL_URL` points to a versioned Apps Script web app deployment, a plain `clasp push` is not enough.

1. Redeploy the `central-tracker` web app.
2. Copy the new deployment URL if it changed.
3. Update `TRACKING_CENTRAL_URL` in the add-on's script properties.
4. Re-send a fresh email for validation.
