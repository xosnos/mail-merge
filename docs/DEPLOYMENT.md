# UNAVSA Mail Merge: Deployment Guide

This guide covers the necessary steps to deploy the UNAVSA Mail Merge tool as an internal Google Workspace Add-on for `unavsa.org`.

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
5. Save and continue through the summary screen.

### 4. Link Apps Script to GCP Project
1. Find your **Project Number** in the GCP Console (on the Project Info panel of the dashboard).
2. Open the Apps Script Editor for your Mail Merge project.
3. Click the gear icon (**Project Settings**) on the left.
4. Under **Google Cloud Platform (GCP) Project**, click **Change project**.
5. Enter the Project Number from step 1 and click **Set project**.

---

## Phase 3: Deployment & Publishing

### 1. Deploy the Web App (For Open Tracking)
The Web App needs to be deployed so the pixel tracking system has a URL to receive data.
1. In the Apps Script Editor, click **Deploy > New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Set **Execute as** to **User deploying the web app (Me)**.
4. Set **Who has access** to **Anyone**. (This allows the tracking pixel in emails to reach the app without the recipient logging in).
5. Click **Deploy**.
6. **Important:** Copy the resulting **Web App URL**. Your users will need to paste this into the Add-on's UI (Advanced Settings) to enable open tracking.

### 2. Publish the Workspace Add-on
1. Go back to your Google Cloud Console.
2. Navigate to **APIs & Services > Google Workspace Marketplace SDK**.
3. Go to the **App Integration** tab.
4. Select **Google Sheets add-on**.
5. You may be asked for a **Script ID** or **Deployment ID**. Provide the Apps Script ID found in Project Settings.
6. Under the **Store Listing** tab, fill out all required fields (Name, Short description, Category, Graphics/Logos).
7. Set the application visibility to **Private** (so it only publishes to `unavsa.org` users).
8. Click **Publish**.

### 3. Installation
Once published privately, users within your organization can install it:
1. Open a Google Sheet.
2. Click **Extensions > Add-ons > Get add-ons**.
3. Search for "UNAVSA Mail Merge" or navigate to the "Internal Apps" section of the marketplace.
4. Install the Add-on. It will appear on the right-side panel when opening Google Sheets.