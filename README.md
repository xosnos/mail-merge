# UNAVSA Mail Merge

A powerful, open-source Google Sheets add-on for personalized mail merges with advanced tracking and scheduling.

## 🚀 Key Features

- **Personalized Emails**: Use `{{Variable Name}}` in your Gmail drafts to automatically pull data from your spreadsheet.
- **Open Tracking**: Real-time open tracking using a centralized tracking pixel. No extra setup required per user!
- **Scheduling**: Schedule your mail merge to run at a future date and time.
- **Analytics Dashboard**: Live view of Sent, Opened, Replied, and Bounced metrics directly in your sidebar.
- **Draft Validation**: Automatically checks if your draft's variables match your sheet columns before sending.

## 🛠 Setup & Installation

### For Users
1. Open your Google Sheet.
2. Go to **Extensions > Add-ons > Get add-ons**.
3. Search for "UNAVSA Mail Merge" (Internal) and install.
4. Open the add-on from the side panel.

### For Developers (Deploying)

Detailed guides are located in the `docs/` directory:

- [Deployment Guide](./docs/DEPLOYMENT.md): How to publish the add-on within your organization.
- [Central Tracker Setup](./docs/CENTRAL_TRACKING_SETUP.md): How to set up the centralized open tracking system.

## 📁 Repository Structure

- `src/`: The core add-on script (Google Apps Script).
- `central-tracker/`: Standalone script for the centralized open tracking pixel.
- `docs/`: Guides and technical documentation.

## 🔒 Security & Privacy

- This tool respects your data and only accesses the spreadsheet it's explicitly enabled for.
- Open tracking uses a secure, HMAC-signed pixel to ensure your data is never exposed.
- Scheduled merges are handled by secure, time-driven Google Apps Script triggers.

---

Built with ❤️ for UNAVSA.
