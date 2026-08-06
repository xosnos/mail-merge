# UNAVSA Mail Merge

A powerful, open-source Google Sheets add-on for personalized mail merges with
advanced tracking and per-tab campaign isolation.

## 🚀 Key Features

- **Personalized Emails**: Use `{{Variable Name}}` in your Gmail drafts to
  automatically pull data from your spreadsheet.
- **Dynamic CC & BCC**: Add "CC" or "BCC" columns to dynamically copy different
  people on each row's email.
- **High-Speed Batch Sending**: Sends campaign emails in parallel bursts with
  buffered sheet updates so large merges finish much faster than row-by-row
  processing.
- **Scheduled Sending**: Schedule email dispatch for a specific future date and
  time with local timezone offset calculations and interactive cancellation
  support.
- **Open & Bounce Tracking**: Real-time open tracking using a centralized
  tracking pixel with HMAC-signed URLs, Tracking IDs, and bounce checking that
  logs directly to your spreadsheet.
- **Test Emails**: Send a test email to yourself to verify variables and
  formatting before running a full campaign (forces CC/BCC to empty for testing
  security).
- **Campaign Labels**: Each campaign creates or reuses a Gmail label so related
  replies and analytics can be searched efficiently.
- **Draft Validation**: Automatically checks if your draft's variables match
  your sheet columns before sending.
- **Smart Filtering**: Hidden or filtered rows in your spreadsheet are
  automatically skipped during execution.
- **Resilient Execution**: Enterprise-grade exponential backoff handles Google
  API rate limits, background dead-letter logging captures crashes, and
  spreadsheet-scoped trigger cleanup prevents time-based trigger buildup.

## 🛠 Setup & Installation

### For Users

1. Open your Google Sheet.
2. Go to **Extensions > Add-ons > Get add-ons**.
3. Search for "UNAVSA Mail Merge" (Internal) and install.
4. Open the add-on from the side panel.

### For Developers (Deploying)

Detailed guides and architectural documentation are located in the `docs/`
directory:

- [Architecture Overview](./docs/ARCHITECTURE.md): Technical deep-dive into the
  decoupled system.
- [User Experience Design](./docs/UX_DESIGN.md): The user journey, UI
  constraints, and flow.
- [Deployment Guide](./docs/DEPLOYMENT.md): How to publish the add-on within
  your organization.
- [Central Tracker Setup](./docs/CENTRAL_TRACKING_SETUP.md): How to set up the
  centralized open tracking system.

## 📁 Repository Structure

- `src/`: The core add-on script (Google Apps Script) organized into core,
  services, ui, and utils.
- `central-tracker/`: Standalone script for the centralized open tracking pixel.
- `docs/`: Guides and technical documentation.
- `package.json`: Contains Bun scripts (`bun run deploy`, `bun run lint`,
  `bun test`) for local development and Clasp deployment.
- `jsconfig.json`: IDE configuration for cross-file Google Apps Script global
  scope resolution.

## 🔒 Security & Privacy

- This tool respects your data and only accesses the spreadsheet it's explicitly
  enabled for.
- Open tracking uses a secure, HMAC-signed pixel to ensure your data is never
  exposed.

## 📝 Operational Notes

- The add-on uses immediate background triggers to escape the sidebar time
  limit, then resumes long runs in roughly 1-minute increments when a batch
  approaches the Apps Script execution ceiling.
- If you update the central tracker and your `TRACKING_CENTRAL_URL` points to a
  versioned web app deployment instead of `@HEAD`, redeploy the web app and
  update the script property so new tracker code is actually served.
