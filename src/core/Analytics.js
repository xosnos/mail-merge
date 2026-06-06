/**
 * Analytics Engine — Tracking opens, bounces, and replies.
 * Includes background automation via time-driven triggers.
 */

/**
 * Scans Gmail for bounces (mailer-daemon) and cross-references with the active sheet.
 * Improved: attempts to match via X-Campaign-ID header in the NDR, falls back to email regex.
 * @returns {Object} { success: boolean, message: string, bounceCount: number }
 */
function checkBounces(startTime = Date.now(), spreadsheetId, sheetName) {
  try {
    let spreadsheet;
    let sheet;

    // Prefer the explicit tab passed by the scanner; fall back to active (manual UI).
    if (spreadsheetId && sheetName) {
      try {
        spreadsheet = SpreadsheetApp.openById(spreadsheetId);
        sheet = spreadsheet.getSheetByName(sheetName);
      } catch (e) {
        // Fall through to active context.
      }
    }

    if (!spreadsheet || !sheet) {
      spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      if (spreadsheet) {
        sheet = spreadsheet.getActiveSheet();
      }
      if (sheet) {
        spreadsheetId = spreadsheet.getId();
        sheetName = sheet.getName();
      }
    }

    if (!sheet)
      return { success: false, message: 'Could not resolve target sheet.', bounceCount: 0 };

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, message: 'No data in sheet.', bounceCount: 0 };

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const configuredEmailCol = getProperty(CONFIG.KEYS.EMAIL_COLUMN, spreadsheetId, sheetName);
    let emailColIndex = configuredEmailCol
      ? headers.findIndex((h) => String(h).trim() === configuredEmailCol)
      : -1;
    if (emailColIndex === -1) {
      emailColIndex = headers.findIndex((h) => String(h).toLowerCase().includes('email'));
    }
    const statusColIndex = headers.findIndex((h) => String(h).toLowerCase() === 'merge status');

    if (emailColIndex === -1)
      return { success: false, message: 'No email column to match.', bounceCount: 0 };
    if (statusColIndex === -1)
      return { success: false, message: "No 'Merge status' column found.", bounceCount: 0 };

    // Get current campaign ID for header matching (scoped to this tab)
    const currentCampaignId = getProperty(CONFIG.KEYS.CAMPAIGN_ID, spreadsheetId, sheetName) || '';
    const sheetNotes = sheet.getDataRange().getNotes();

    const MAX_EXECUTION_TIME_MS = 210000; // 3.5 minutes
    if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
      return {
        success: true,
        message: 'Execution limit reached before bounces scan.',
        bounceCount: 0
      };
    }

    // Pre-compute Tracking ID lookup (O(1) search)
    const tidToRow = {};
    for (let r = 0; r < sheetNotes.length; r++) {
      for (let c = 0; c < sheetNotes[r].length; c++) {
        const note = sheetNotes[r][c];
        if (note && note.includes('Tracking ID: ')) {
          const match = note.match(/Tracking ID:\s*([a-z0-9-]+)/i);
          if (match) {
            tidToRow[match[1]] = r + 1; // 1-based index
          }
        }
      }
    }

    if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
      return {
        success: true,
        message: 'Execution limit reached during bounces lookup.',
        bounceCount: 0
      };
    }

    // Search for recent bounce messages (cursor scoped to this tab)
    let lastBounceTimeStr = getProperty(
      CONFIG.KEYS.LAST_BOUNCE_THREAD_TIME,
      spreadsheetId,
      sheetName
    );
    let lastBounceTime = lastBounceTimeStr ? parseInt(lastBounceTimeStr, 10) : 0;

    let searchQuery = 'from:mailer-daemon in:inbox newer_than:7d';
    if (lastBounceTime > 0) {
      searchQuery = `from:mailer-daemon in:inbox after:${Math.floor(lastBounceTime / 1000)}`;
    }
    const threads = GmailApp.search(searchQuery);
    threads.reverse(); // Process oldest to newest to ensure forward progress on timeout

    const bouncedEmails = {};
    let maxProcessedTime = lastBounceTime;

    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];
      const threadTime = thread.getLastMessageDate().getTime();

      if (threadTime <= lastBounceTime) continue;

      if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
        console.log('Analytics scanner reaching execution limit. Halting bounces scan.');
        break;
      }
      const msgs = thread.getMessages();
      msgs.forEach((m) => {
        const body = m.getPlainBody();
        let rawContent = '';

        // Try to get raw message for header matching
        try {
          const rawMsg = Gmail.Users.Messages.get('me', m.getId(), { format: 'raw' });
          if (rawMsg && rawMsg.raw) {
            rawContent = Utilities.newBlob(
              Utilities.base64DecodeWebSafe(rawMsg.raw)
            ).getDataAsString();
          }
        } catch (e) {
          // Fall back to body-only matching
          rawContent = body;
        }

        // Check if this bounce is from our campaign (via X-Campaign-ID header)
        const campaignRegex = new RegExp(`x-campaign-id:\\s*${currentCampaignId}`, 'i');
        const isCampaignBounce = currentCampaignId && campaignRegex.test(rawContent);

        // Try to extract X-Tracking-ID and X-Row-ID for precision matching
        const tidMatch = rawContent.match(/x-tracking-id:\s*([a-z0-9-]+)/i);
        const rowMatch = rawContent.match(/x-row-id:\s*(\d+)/i);

        if (isCampaignBounce && tidMatch) {
          // Precision match by Tracking ID
          const tid = tidMatch[1];
          const foundRow = tidToRow[tid] || -1;
          if (foundRow !== -1) {
            bouncedEmails['__row__' + foundRow] = foundRow;
          }
        } else if (isCampaignBounce && rowMatch) {
          // Precision match fallback to Row ID
          const rowNum = parseInt(rowMatch[1], 10);
          bouncedEmails['__row__' + rowNum] = rowNum;
        } else {
          // Fallback: extract email addresses from NDR body
          const emailMatches = body.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g);
          if (emailMatches) {
            emailMatches.forEach((em) => {
              bouncedEmails[em.toLowerCase()] = true;
            });
          }
        }
      });
      maxProcessedTime = threadTime;
    }

    if (maxProcessedTime > lastBounceTime) {
      setProperty(
        CONFIG.KEYS.LAST_BOUNCE_THREAD_TIME,
        maxProcessedTime.toString(),
        spreadsheetId,
        sheetName
      );
    }

    if (Object.keys(bouncedEmails).length === 0) {
      return {
        success: true,
        message: 'No recent bounce notifications found in inbox.',
        bounceCount: 0
      };
    }

    const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
    const data = dataRange.getValues();
    let bounceCount = 0;
    const tz = spreadsheet.getSpreadsheetTimeZone() || 'GMT';
    const timeString = Utilities.formatDate(new Date(), tz, 'MM/dd HH:mm z');

    for (let i = 0; i < data.length; i++) {
      const email = String(data[i][emailColIndex]).trim().toLowerCase();
      const existingStatus = String(data[i][statusColIndex]).trim().toLowerCase();

      // Don't overwrite existing "Bounced" status
      if (existingStatus.includes('bounced')) continue;

      // Only process rows that have actually been sent for this campaign
      // This prevents applying 'Bounced' to empty/unprocessed rows.
      if (
        !existingStatus.includes('sent') &&
        !existingStatus.includes('opened') &&
        !existingStatus.includes('replied')
      )
        continue;

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
        const range = sheet.getRange(rowNum, statusColIndex + 1);
        range.setValue('Bounced');
        const existingNote = range.getNote() || '';
        const newNote = `Bounced: ${timeString}`;
        range.setNote(existingNote ? existingNote + '\n' + newNote : newNote);
        bounceCount++;
      }
    }

    return {
      success: true,
      message: `Checked bounces. Marked ${bounceCount} rows as bounced.`,
      bounceCount
    };
  } catch (err) {
    return { success: false, message: err.message, bounceCount: 0 };
  }
}

/**
 * Scans Gmail inbox for replies to campaign emails by matching the X-Campaign-ID header.
 * Updates "Merge status" to "Replied <timestamp>" for matched rows.
 * @returns {Object} { success: boolean, message: string, replyCount: number }
 */
function checkReplies(startTime = Date.now(), spreadsheetId, sheetName) {
  try {
    let spreadsheet;
    let sheet;

    // Prefer the explicit tab passed by the scanner; fall back to active (manual UI).
    if (spreadsheetId && sheetName) {
      try {
        spreadsheet = SpreadsheetApp.openById(spreadsheetId);
        sheet = spreadsheet.getSheetByName(sheetName);
      } catch (e) {
        // Fall through to active context.
      }
    }

    if (!spreadsheet || !sheet) {
      spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      if (spreadsheet) {
        sheet = spreadsheet.getActiveSheet();
      }
      if (sheet) {
        spreadsheetId = spreadsheet.getId();
        sheetName = sheet.getName();
      }
    }

    if (!sheet)
      return { success: false, message: 'Could not resolve target sheet.', replyCount: 0 };

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, message: 'No data in sheet.', replyCount: 0 };

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const configuredEmailCol = getProperty(CONFIG.KEYS.EMAIL_COLUMN, spreadsheetId, sheetName);
    let emailColIndex = configuredEmailCol
      ? headers.findIndex((h) => String(h).trim() === configuredEmailCol)
      : -1;
    if (emailColIndex === -1) {
      emailColIndex = headers.findIndex((h) => String(h).toLowerCase().includes('email'));
    }
    const statusColIndex = headers.findIndex((h) => String(h).toLowerCase() === 'merge status');

    if (emailColIndex === -1)
      return { success: false, message: 'No email column found.', replyCount: 0 };
    if (statusColIndex === -1)
      return { success: false, message: "No 'Merge status' column found.", replyCount: 0 };

    const currentCampaignId = getProperty(CONFIG.KEYS.CAMPAIGN_ID, spreadsheetId, sheetName);
    if (!currentCampaignId) {
      return { success: true, message: 'No campaign ID found. Send a batch first.', replyCount: 0 };
    }

    const sheetNotes = sheet.getDataRange().getNotes();

    const MAX_EXECUTION_TIME_MS = 210000; // 3.5 minutes
    if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
      return {
        success: true,
        message: 'Execution limit reached before replies scan.',
        replyCount: 0
      };
    }

    // Pre-compute Tracking ID lookup (O(1) search)
    const tidToRow = {};
    for (let r = 0; r < sheetNotes.length; r++) {
      for (let c = 0; c < sheetNotes[r].length; c++) {
        const note = sheetNotes[r][c];
        if (note && note.includes('Tracking ID: ')) {
          const match = note.match(/Tracking ID:\s*([a-z0-9-]+)/i);
          if (match) {
            tidToRow[match[1]] = r + 1; // 1-based index
          }
        }
      }
    }

    if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
      return {
        success: true,
        message: 'Execution limit reached during replies lookup.',
        replyCount: 0
      };
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

    if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
      return {
        success: true,
        message: 'Execution limit reached before Gmail search.',
        replyCount: 0
      };
    }

    // Search for recent replies in inbox (not sent by us)
    let lastReplyTimeStr = getProperty(
      CONFIG.KEYS.LAST_REPLY_THREAD_TIME,
      spreadsheetId,
      sheetName
    );
    let lastReplyTime = lastReplyTimeStr ? parseInt(lastReplyTimeStr, 10) : 0;

    const campaignLabel = getProperty(CONFIG.KEYS.CAMPAIGN_LABEL, spreadsheetId, sheetName);
    let timeQuery = 'newer_than:7d';
    if (lastReplyTime > 0) {
      timeQuery = `after:${Math.floor(lastReplyTime / 1000)}`;
    }

    let searchQuery = `in:inbox ${timeQuery} -from:me`;
    if (campaignLabel) {
      searchQuery = `label:"${campaignLabel.replace(/"/g, '\\"')}" in:inbox ${timeQuery} -from:me`;
    }
    const threads = GmailApp.search(searchQuery);
    threads.reverse(); // Process oldest to newest

    let replyCount = 0;
    const tz = spreadsheet.getSpreadsheetTimeZone() || 'GMT';
    const timeString = Utilities.formatDate(new Date(), tz, 'MM/dd HH:mm z');
    const processedRows = {};
    let maxProcessedTime = lastReplyTime;

    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];
      const threadTime = thread.getLastMessageDate().getTime();

      if (threadTime <= lastReplyTime) continue;

      if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
        console.log('Analytics scanner reaching execution limit. Halting replies scan.');
        break;
      }
      const messages = thread.getMessages();

      let threadHasCampaign = false;
      let matchedRowId = null;
      let matchedTid = null;

      // First pass: determine if this thread belongs to our campaign
      for (const msg of messages) {
        try {
          const fullMsg = Gmail.Users.Messages.get('me', msg.getId(), {
            format: 'metadata',
            metadataHeaders: ['X-Campaign-ID', 'X-Row-ID', 'X-Tracking-ID']
          });
          if (fullMsg && fullMsg.payload && fullMsg.payload.headers) {
            fullMsg.payload.headers.forEach((header) => {
              const headerName = String(header.name || '').toLowerCase();
              const headerValue = String(header.value || '').trim();
              if (headerName === 'x-campaign-id' && headerValue === currentCampaignId) {
                threadHasCampaign = true;
              }
              if (headerName === 'x-row-id') {
                matchedRowId = parseInt(headerValue, 10);
              }
              if (headerName === 'x-tracking-id') {
                matchedTid = headerValue;
              }
            });
          }
        } catch (e) {
          continue;
        }
        if (threadHasCampaign) break;
      }

      if (!threadHasCampaign) continue;

      // Second pass: process replies in this campaign thread
      messages.forEach((msg) => {
        const fromHeader = String(msg.getFrom() || '');
        const senderMatch = fromHeader.match(/<([^>]+)>/);
        const fromAddress = (senderMatch ? senderMatch[1] : fromHeader).trim().toLowerCase();

        // Skip messages sent by us
        if (
          fromAddress === Session.getActiveUser().getEmail().toLowerCase() ||
          getProperty(CONFIG.KEYS.SENDER_ALIAS, spreadsheetId, sheetName)?.toLowerCase() ===
            fromAddress
        ) {
          return;
        }

        // Skip bounce messages (mailer-daemon/postmaster) so they aren't counted as replies
        if (fromAddress.includes('mailer-daemon') || fromAddress.includes('postmaster')) {
          return;
        }

        // Search for row by tracking ID
        const foundRowByTid = matchedTid ? tidToRow[matchedTid] || -1 : -1;

        const rowInfo = emailToRow[fromAddress];

        if (foundRowByTid !== -1 && !processedRows[foundRowByTid]) {
          const range = sheet.getRange(foundRowByTid, statusColIndex + 1);
          const existingStatus = String(range.getValue()).trim().toLowerCase();
          if (
            (existingStatus.includes('sent') || existingStatus.includes('opened')) &&
            !existingStatus.includes('replied') &&
            !existingStatus.includes('bounced')
          ) {
            range.setValue('Replied');
            const existingNote = range.getNote() || '';
            const newNote = `Replied: ${timeString}`;
            range.setNote(existingNote ? existingNote + '\n' + newNote : newNote);
            processedRows[foundRowByTid] = true;
            replyCount++;
          }
        } else if (rowInfo && !processedRows[rowInfo.rowNum]) {
          const currentStatus = rowInfo.status.toLowerCase();
          // Only update if it was actually sent/opened, and not already marked as replied or bounced
          if (
            (currentStatus.includes('sent') || currentStatus.includes('opened')) &&
            !currentStatus.includes('replied') &&
            !currentStatus.includes('bounced')
          ) {
            const range = sheet.getRange(rowInfo.rowNum, statusColIndex + 1);
            range.setValue('Replied');
            const existingNote = range.getNote() || '';
            const newNote = `Replied: ${timeString}`;
            range.setNote(existingNote ? existingNote + '\n' + newNote : newNote);
            processedRows[rowInfo.rowNum] = true;
            replyCount++;
          }
        } else if (matchedRowId && !processedRows[matchedRowId]) {
          // Fallback: use X-Row-ID to identify the row directly
          const range = sheet.getRange(matchedRowId, statusColIndex + 1);
          const existingStatus = String(range.getValue()).trim().toLowerCase();
          if (
            (existingStatus.includes('sent') || existingStatus.includes('opened')) &&
            !existingStatus.includes('replied') &&
            !existingStatus.includes('bounced')
          ) {
            range.setValue('Replied');
            const existingNote = range.getNote() || '';
            const newNote = `Replied: ${timeString}`;
            range.setNote(existingNote ? existingNote + '\n' + newNote : newNote);
            processedRows[matchedRowId] = true;
            replyCount++;
          }
        }
      });
      maxProcessedTime = threadTime;
    }

    if (maxProcessedTime > lastReplyTime) {
      setProperty(
        CONFIG.KEYS.LAST_REPLY_THREAD_TIME,
        maxProcessedTime.toString(),
        spreadsheetId,
        sheetName
      );
    }

    return {
      success: true,
      message: `Checked replies. Found ${replyCount} new replies.`,
      replyCount
    };
  } catch (err) {
    return { success: false, message: err.message, replyCount: 0 };
  }
}

/**
 * Unified analytics scanner. Runs bounces then replies.
 * Called by both the sidebar "Refresh Analytics" button and the background trigger.
 * @param {Object} [e] Trigger event object
 * @returns {Object} { success: boolean, message: string }
 */
function runAnalyticsScanner(e) {
  try {
    setTriggerSpreadsheetIdContext(e);
    const startTime = Date.now();

    // Determine which tabs to scan. A background trigger scans every tab registered
    // for its spreadsheet; a manual UI refresh scans just the active tab.
    let spreadsheetId = null;
    let tabs = [];
    if (e) {
      spreadsheetId = getSpreadsheetIdFromTrigger(e);
      tabs = getCampaignTabs_(spreadsheetId);
      if (!tabs || tabs.length === 0) {
        const mappedTab = getSheetNameFromTrigger(e);
        tabs = mappedTab ? [mappedTab] : [];
      }
    } else {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      spreadsheetId = ss ? ss.getId() : null;
      const sh = SpreadsheetApp.getActiveSheet();
      if (sh) tabs = [sh.getName()];
    }

    if (!tabs || tabs.length === 0) {
      return { success: true, message: 'Analytics scan complete. No campaign tabs to scan.' };
    }

    let totalBounces = 0;
    let totalReplies = 0;
    const errors = [];

    tabs.forEach((tab) => {
      const bounceResult = checkBounces(startTime, spreadsheetId, tab);
      const replyResult = checkReplies(startTime, spreadsheetId, tab);
      if (bounceResult.success) {
        totalBounces += bounceResult.bounceCount || 0;
      } else {
        errors.push(`${tab} bounce: ${bounceResult.message}`);
      }
      if (replyResult.success) {
        totalReplies += replyResult.replyCount || 0;
      } else {
        errors.push(`${tab} reply: ${replyResult.message}`);
      }
    });

    let message = `Analytics scan complete. Bounces: ${totalBounces} | Replies: ${totalReplies}`;
    if (errors.length > 0) {
      message += ' | Errors: ' + errors.join('; ');
    }
    return { success: errors.length === 0, message };
  } catch (err) {
    if (typeof ErrorLib !== 'undefined') ErrorLib.logError(err, 'runAnalyticsScanner');
    return { success: false, message: 'Analytics scanner crashed: ' + err.message };
  }
}

/**
 * Ensures a single time-driven analytics scanner runs every 3 hours for the
 * spreadsheet, and registers the given tab so the scanner covers it. There is one
 * scanner per spreadsheet (not per tab) to stay well within the trigger quota; the
 * scanner iterates every registered tab on each run.
 * @param {string} [spreadsheetId] Defaults to the active spreadsheet.
 * @param {string} [sheetName] Defaults to the active sheet.
 * @returns {Object} { success: boolean, message: string }
 */
function setupAnalyticsTrigger(spreadsheetId, sheetName) {
  try {
    let ssId = spreadsheetId;
    let tab = sheetName;
    if (!ssId) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      ssId = ss ? ss.getId() : null;
    }
    if (!tab) {
      const sh = SpreadsheetApp.getActiveSheet();
      tab = sh ? sh.getName() : null;
    }

    // Register this tab for scanning.
    if (ssId && tab) registerCampaignTab_(ssId, tab);

    // Ensure exactly one analytics trigger per spreadsheet (keyed spreadsheet-wide).
    removeAnalyticsTrigger(ssId);

    const trigger = ScriptApp.newTrigger('runAnalyticsScanner').timeBased().everyHours(3).create();
    mapTriggerToSpreadsheet(trigger, ssId, '');
    setProperty(CONFIG.KEYS.ANALYTICS_TRIGGER_ID, trigger.getUniqueId(), ssId, '');
    if (ssId) setProperty(CONFIG.KEYS.ANALYTICS_SPREADSHEET_ID, ssId, ssId, '');

    return { success: true, message: 'Background scanning enabled (every 3 hours).' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Removes the spreadsheet's background analytics trigger.
 * @param {string} [spreadsheetId]
 * @returns {Object} { success: boolean, message: string }
 */
function removeAnalyticsTrigger(spreadsheetId) {
  try {
    let ssId = spreadsheetId;
    if (!ssId) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      ssId = ss ? ss.getId() : null;
    }

    const triggerId = getProperty(CONFIG.KEYS.ANALYTICS_TRIGGER_ID, ssId, '');
    if (triggerId) deleteTriggerMapping(triggerId);

    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('runAnalyticsScanner', ssId);
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'runAnalyticsScanner') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    PropertiesService.getUserProperties().deleteProperty(
      _getCompositeKey(CONFIG.KEYS.ANALYTICS_TRIGGER_ID, ssId, '')
    );

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
    let spreadsheet;
    let sheet;

    // Attempt to load the saved context for background execution
    const savedSpreadsheetId = getProperty(CONFIG.KEYS.ANALYTICS_SPREADSHEET_ID);
    const savedSheetName = getProperty(CONFIG.KEYS.ANALYTICS_SHEET_NAME);

    if (savedSpreadsheetId && savedSheetName) {
      try {
        spreadsheet = SpreadsheetApp.openById(savedSpreadsheetId);
        sheet = spreadsheet.getSheetByName(savedSheetName);
      } catch (e) {
        // Fallback below if the sheet was deleted or permissions changed
      }
    }

    // Fallback to active spreadsheet (for manual UI clicks)
    if (!spreadsheet || !sheet) {
      spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      if (spreadsheet) {
        sheet = spreadsheet.getActiveSheet();
      }
    }

    if (!sheet) return metrics;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return metrics;

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const statusColIndex = headers.findIndex((h) => String(h).toLowerCase() === 'merge status');

    if (statusColIndex === -1) return metrics;

    const statusRange = sheet.getRange(2, statusColIndex + 1, lastRow - 1, 1);
    const statuses = statusRange.getValues();

    statuses.forEach((row) => {
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
