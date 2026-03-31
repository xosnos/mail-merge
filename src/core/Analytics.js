/**
 * Analytics Engine — Tracking opens, bounces, and replies.
 * Includes background automation via time-driven triggers.
 */

/**
 * Scans Gmail for bounces (mailer-daemon) and cross-references with the active sheet.
 * Improved: attempts to match via X-Campaign-ID header in the NDR, falls back to email regex.
 * @returns {Object} { success: boolean, message: string, bounceCount: number }
 */
function checkBounces() {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, message: 'No data in sheet.', bounceCount: 0 };

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const configuredEmailCol = getProperty(CONFIG.KEYS.EMAIL_COLUMN);
    let emailColIndex = configuredEmailCol ? headers.findIndex(h => String(h).trim() === configuredEmailCol) : -1;
    if (emailColIndex === -1) {
      emailColIndex = headers.findIndex(h => String(h).toLowerCase().includes('email'));
    }
    const statusColIndex = headers.findIndex(h => String(h).toLowerCase() === 'merge status');

    if (emailColIndex === -1) return { success: false, message: 'No email column to match.', bounceCount: 0 };
    if (statusColIndex === -1) return { success: false, message: "No 'Merge status' column found.", bounceCount: 0 };

    // Get current campaign ID for header matching
    const currentCampaignId = getProperty(CONFIG.KEYS.CAMPAIGN_ID) || '';

    // Search for recent bounce messages
    const threads = GmailApp.search('from:mailer-daemon in:inbox newer_than:7d');
    const bouncedEmails = {};

    threads.forEach(thread => {
      const msgs = thread.getMessages();
      msgs.forEach(m => {
        const body = m.getPlainBody();
        let rawContent = '';

        // Try to get raw message for header matching
        try {
          const rawMsg = Gmail.Users.Messages.get('me', m.getId(), { format: 'raw' });
          if (rawMsg && rawMsg.raw) {
            rawContent = Utilities.newBlob(Utilities.base64DecodeWebSafe(rawMsg.raw)).getDataAsString();
          }
        } catch (e) {
          // Fall back to body-only matching
          rawContent = body;
        }

        // Check if this bounce is from our campaign (via X-Campaign-ID header)
        const campaignRegex = new RegExp(`x-campaign-id:\\s*${currentCampaignId}`, 'i');
        const isCampaignBounce = currentCampaignId && campaignRegex.test(rawContent);

        // Try to extract X-Row-ID for precision matching
        const rowMatch = rawContent.match(/x-row-id:\s*(\d+)/i);

        if (isCampaignBounce && rowMatch) {
          // Precision match: we know the exact row
          const rowNum = parseInt(rowMatch[1], 10);
          bouncedEmails['__row__' + rowNum] = rowNum;
        } else {
          // Fallback: extract email addresses from NDR body
          const emailMatches = body.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g);
          if (emailMatches) {
            emailMatches.forEach(em => {
              bouncedEmails[em.toLowerCase()] = true;
            });
          }
        }
      });
    });

    if (Object.keys(bouncedEmails).length === 0) {
      return { success: true, message: 'No recent bounce notifications found in inbox.', bounceCount: 0 };
    }

    const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
    const data = dataRange.getValues();
    let bounceCount = 0;
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'GMT';
    const timeString = Utilities.formatDate(new Date(), tz, 'MM/dd HH:mm');

    for (let i = 0; i < data.length; i++) {
      const email = String(data[i][emailColIndex]).trim().toLowerCase();
      const existingStatus = String(data[i][statusColIndex]).trim().toLowerCase();

      // Don't overwrite existing "Bounced" status
      if (existingStatus.includes('bounced')) continue;

      const rowNum = i + 2;
      let isBounced = false;

      // Check precision match first (by row ID from headers)
      if (bouncedEmails['__row__' + rowNum]) {
        isBounced = true;
      } else if (email && bouncedEmails[email]) {
        // Fallback: match by email address
        isBounced = true;
      }

      if (isBounced) {
        sheet.getRange(rowNum, statusColIndex + 1).setValue(`Bounced ${timeString}`);
        bounceCount++;
      }
    }

    return { success: true, message: `Checked bounces. Marked ${bounceCount} rows as bounced.`, bounceCount };
  } catch (err) {
    return { success: false, message: err.message, bounceCount: 0 };
  }
}

/**
 * Scans Gmail inbox for replies to campaign emails by matching the X-Campaign-ID header.
 * Updates "Merge status" to "Replied <timestamp>" for matched rows.
 * @returns {Object} { success: boolean, message: string, replyCount: number }
 */
function checkReplies() {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, message: 'No data in sheet.', replyCount: 0 };

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const configuredEmailCol = getProperty(CONFIG.KEYS.EMAIL_COLUMN);
    let emailColIndex = configuredEmailCol ? headers.findIndex(h => String(h).trim() === configuredEmailCol) : -1;
    if (emailColIndex === -1) {
      emailColIndex = headers.findIndex(h => String(h).toLowerCase().includes('email'));
    }
    const statusColIndex = headers.findIndex(h => String(h).toLowerCase() === 'merge status');

    if (emailColIndex === -1) return { success: false, message: 'No email column found.', replyCount: 0 };
    if (statusColIndex === -1) return { success: false, message: "No 'Merge status' column found.", replyCount: 0 };

    const currentCampaignId = getProperty(CONFIG.KEYS.CAMPAIGN_ID);
    if (!currentCampaignId) {
      return { success: true, message: 'No campaign ID found. Send a batch first.', replyCount: 0 };
    }

    // Build a lookup of emails → row numbers from the sheet
    const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
    const data = dataRange.getValues();
    const emailToRow = {};

    data.forEach((row, idx) => {
      const email = String(row[emailColIndex]).trim().toLowerCase();
      if (email) {
        emailToRow[email] = { rowNum: idx + 2, status: String(row[statusColIndex]).trim() };
      }
    });

    // Search for recent replies in inbox (not sent by us)
    const threads = GmailApp.search('in:inbox newer_than:7d -from:me');
    let replyCount = 0;
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'GMT';
    const timeString = Utilities.formatDate(new Date(), tz, 'MM/dd HH:mm');
    const processedRows = {};

    threads.forEach(thread => {
      const messages = thread.getMessages();

      let threadHasCampaign = false;
      let matchedRowId = null;

      // First pass: determine if this thread belongs to our campaign
      for (const msg of messages) {
        try {
          const fullMsg = Gmail.Users.Messages.get('me', msg.getId(), { format: 'metadata', metadataHeaders: ['X-Campaign-ID', 'X-Row-ID'] });
          if (fullMsg && fullMsg.payload && fullMsg.payload.headers) {
            fullMsg.payload.headers.forEach(header => {
              const headerName = String(header.name || '').toLowerCase();
              const headerValue = String(header.value || '').trim();
              if (headerName === 'x-campaign-id' && headerValue === currentCampaignId) {
                threadHasCampaign = true;
              }
              if (headerName === 'x-row-id') {
                matchedRowId = parseInt(headerValue, 10);
              }
            });
          }
        } catch (e) {
          continue;
        }
        if (threadHasCampaign) break;
      }

      if (!threadHasCampaign) return;

      // Second pass: process replies in this campaign thread
      messages.forEach(msg => {
        const fromHeader = String(msg.getFrom() || '');
        const senderMatch = fromHeader.match(/<([^>]+)>/);
        const fromAddress = (senderMatch ? senderMatch[1] : fromHeader).trim().toLowerCase();

        // Skip messages sent by us
        if (fromAddress === Session.getActiveUser().getEmail().toLowerCase() || getProperty(CONFIG.KEYS.SENDER_ALIAS)?.toLowerCase() === fromAddress) {
          return;
        }

        // If the message is FROM someone in our spreadsheet, it's a reply
        const rowInfo = emailToRow[fromAddress];

        if (rowInfo && !processedRows[rowInfo.rowNum]) {
          const currentStatus = rowInfo.status.toLowerCase();
          // Only update if not already marked as replied
          if (!currentStatus.includes('replied')) {
            sheet.getRange(rowInfo.rowNum, statusColIndex + 1).setValue(`Replied ${timeString}`);
            processedRows[rowInfo.rowNum] = true;
            replyCount++;
          }
        } else if (matchedRowId && !processedRows[matchedRowId]) {
          // Fallback: use X-Row-ID to identify the row directly
          const existingStatus = String(sheet.getRange(matchedRowId, statusColIndex + 1).getValue()).trim().toLowerCase();
          if (!existingStatus.includes('replied')) {
            sheet.getRange(matchedRowId, statusColIndex + 1).setValue(`Replied ${timeString}`);
            processedRows[matchedRowId] = true;
            replyCount++;
          }
        }
      });
    });

    return { success: true, message: `Checked replies. Found ${replyCount} new replies.`, replyCount };
  } catch (err) {
    return { success: false, message: err.message, replyCount: 0 };
  }
}

/**
 * Unified analytics scanner. Runs bounces then replies.
 * Called by both the sidebar "Refresh Analytics" button and the background trigger.
 * @returns {Object} { success: boolean, message: string }
 */
function runAnalyticsScanner() {
  const bounceResult = checkBounces();
  const replyResult = checkReplies();

  const messages = [];
  if (bounceResult.success) {
    messages.push(`Bounces: ${bounceResult.bounceCount || 0}`);
  } else {
    messages.push('Bounce error: ' + bounceResult.message);
  }

  if (replyResult.success) {
    messages.push(`Replies: ${replyResult.replyCount || 0}`);
  } else {
    messages.push('Reply error: ' + replyResult.message);
  }

  return {
    success: bounceResult.success && replyResult.success,
    message: 'Analytics scan complete. ' + messages.join(' | ')
  };
}

/**
 * Creates a time-driven trigger to run the analytics scanner every 15 minutes.
 * Stores the trigger ID in PropertiesService for later cleanup.
 * @returns {Object} { success: boolean, message: string }
 */
function setupAnalyticsTrigger() {
  try {
    // Remove existing trigger first to avoid duplicates
    removeAnalyticsTrigger();

    const trigger = ScriptApp.newTrigger('runAnalyticsScanner')
      .timeBased()
      .everyHours(3)
      .create();

    setProperty(CONFIG.KEYS.ANALYTICS_TRIGGER_ID, trigger.getUniqueId());

    return { success: true, message: 'Background scanning enabled (every 15 minutes).' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Removes the background analytics trigger.
 * @returns {Object} { success: boolean, message: string }
 */
function removeAnalyticsTrigger() {
  try {
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('runAnalyticsScanner');
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach(t => {
        if (t.getHandlerFunction() === 'runAnalyticsScanner') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    PropertiesService.getDocumentProperties().deleteProperty(CONFIG.KEYS.ANALYTICS_TRIGGER_ID);

    return { success: true, message: 'Background scanning disabled.' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}


/**
 * Calculates campaign metrics based on the "Merge status" column.
 * @returns {Object} { total: number, sent: number, opened: number, replied: number, bounced: number }
 */
function getCampaignMetrics() {
  const metrics = { total: 0, sent: 0, opened: 0, replied: 0, bounced: 0, error: null };
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return metrics;

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const statusColIndex = headers.findIndex(h => String(h).toLowerCase() === 'merge status');

    if (statusColIndex === -1) return metrics;

    const statusRange = sheet.getRange(2, statusColIndex + 1, lastRow - 1, 1);
    const statuses = statusRange.getValues();

    statuses.forEach(row => {
      const status = String(row[0]).trim().toLowerCase();
      if (!status) return; // Skip empty statuses

      metrics.total++;
      if (status.includes('bounced')) {
        metrics.bounced++;
      } else if (status.includes('replied')) {
        metrics.replied++;
        metrics.opened++; // A reply implies an open
      } else if (status.includes('opened')) {
        metrics.opened++;
      } else if (status.includes('sent')) {
        metrics.sent++;
      }
    });

    return metrics;
  } catch (err) {
    metrics.error = err.message;
    return metrics;
  }
}
