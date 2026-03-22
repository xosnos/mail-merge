/**
 * Core engine for sending emails via Advanced Gmail API.
 * Uses MimeBuilder.js for raw MIME construction with custom header injection.
 */

// Maximum safe execution time in milliseconds (4 min 30 sec of the 6-min limit)
const MAX_EXECUTION_MS = 270000;

/**
 * Replaces {{variables}} in a string with data from a row.
 * @param {string} template The text containing {{vars}}
 * @param {Array<string>} headers The array of column headers
 * @param {Array<any>} rowData The array of row data
 * @returns {string} The processed string
 */
function replaceVariables(template, headers, rowData) {
  if (!template) return '';
  let result = template;
  headers.forEach((header, index) => {
    const escapedHeader = header.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp('\\{\\{\\s*' + escapedHeader + '\\s*\\}\\}', 'gi');
    const replacement = rowData[index] !== undefined && rowData[index] !== null ? String(rowData[index]) : '';
    result = result.replace(regex, replacement);
  });
  return result;
}

/**
 * Generates a unique campaign ID for tracking.
 * @returns {string} e.g. "camp_abc123_1711234567890"
 */
function generateCampaignId_() {
  const sheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
  const short = sheetId.substring(0, 8);
  return 'camp_' + short + '_' + Date.now();
}

/**
 * Sends a test email to the currently logged-in user using Row 2 data.
 * Uses Advanced Gmail API with custom X-Campaign-ID header for verification.
 * @param {Object} config The settings from the UI
 * @returns {Object} {success: boolean, message: string}
 */
function sendTestEmail(config) {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    if (sheet.getLastRow() < 2) {
      throw new Error('No data found in Row 2 to test with.');
    }

    const testRow = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
    const draft = GmailApp.getDraft(config.draftId);
    if (!draft) throw new Error('Draft not found.');

    const msg = draft.getMessage();

    // Process templates
    const subject = replaceVariables(msg.getSubject(), headers, testRow);
    const htmlBody = replaceVariables(msg.getBody(), headers, testRow);
    const plainBody = replaceVariables(msg.getPlainBody(), headers, testRow);

    // The recipient is the active user for tests
    const recipient = Session.getActiveUser().getEmail();
    const senderEmail = config.senderAlias || recipient;

    // Extract inline image Content-IDs from the draft
    const inlineContentIds = getInlineContentIds_(msg.getId());
    const attachments = msg.getAttachments({includeInlineImages: true});

    // Build MIME message with custom tracking headers
    const raw = buildMimeMessage({
      to: recipient,
      from: senderEmail,
      senderName: config.senderName || '',
      replyTo: config.replyTo || '',
      subject: subject,
      plainBody: plainBody,
      htmlBody: htmlBody,
      attachments: attachments,
      inlineContentIds: inlineContentIds,
      customHeaders: {
        'X-Campaign-ID': 'TEST',
        'X-Row-ID': '2'
      }
    });

    Gmail.Users.Messages.send({ raw: raw }, 'me');

    return { success: true, message: 'Test email successfully sent to ' + recipient };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Sends the batch of emails based on spreadsheet data.
 * Uses Advanced Gmail API with custom headers and timeout management.
 * @param {Object} config The settings from the UI
 * @param {number} [startRow] Row index offset (0-based into data array) for resumption
 * @returns {Object} {success: boolean, message: string}
 */
function sendBatchEmails(config, startRow) {
  try {
    // Save state in case of UI reload
    setProperty(CONFIG.KEYS.SELECTED_DRAFT_ID, config.draftId);
    setProperty(CONFIG.KEYS.SENDER_NAME, config.senderName || '');
    setProperty(CONFIG.KEYS.SENDER_ALIAS, config.senderAlias || '');
    setProperty(CONFIG.KEYS.REPLY_TO, config.replyTo || '');
    setProperty(CONFIG.KEYS.EMAIL_COLUMN, config.emailColumn);
    setProperty(CONFIG.KEYS.WEB_APP_URL, config.webAppUrl || '');

    // Check quota
    const quota = MailApp.getRemainingDailyQuota();
    if (quota < 1) {
      throw new Error('You have reached your daily Google email quota limit.');
    }

    const sheet = SpreadsheetApp.getActiveSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No data available to send.');

    // Pre-flight validation
    const validation = validateTemplate(config.draftId);
    if (!validation.isValid) {
      return { success: false, message: 'Validation failed. Missing columns: ' + validation.missingColumns.join(', ') };
    }

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // Determine which columns are email and merge status
    const emailColIndex = headers.indexOf(config.emailColumn);
    let statusColIndex = headers.findIndex(h => String(h).toLowerCase() === 'merge status');

    if (emailColIndex === -1) throw new Error('Email column not found.');
    if (statusColIndex === -1) {
      statusColIndex = headers.length;
      sheet.getRange(1, statusColIndex + 1).setValue('Merge status').setFontWeight('bold');
    }

    const draft = GmailApp.getDraft(config.draftId);
    if (!draft) throw new Error('Draft not found.');
    const msg = draft.getMessage();
    const inlineContentIds = getInlineContentIds_(msg.getId());
    const attachments = msg.getAttachments({includeInlineImages: true});

    const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
    const data = dataRange.getValues();

    // Generate or retrieve campaign ID
    let campaignId;
    if (startRow && startRow > 0) {
      campaignId = getProperty(CONFIG.KEYS.CAMPAIGN_ID);
    }
    if (!campaignId) {
      campaignId = generateCampaignId_();
      setProperty(CONFIG.KEYS.CAMPAIGN_ID, campaignId);
    }

    const senderEmail = config.senderAlias || Session.getActiveUser().getEmail();
    let sentCount = 0;
    const loopStart = startRow || 0;
    const executionStart = Date.now();

    for (let i = loopStart; i < data.length; i++) {
      // ---- Timeout guard ----
      if (Date.now() - executionStart > MAX_EXECUTION_MS) {
        // Save state and schedule continuation
        setProperty(CONFIG.KEYS.LAST_PROCESSED_ROW, String(i));
        setProperty(CONFIG.KEYS.BATCH_CONFIG, JSON.stringify(config));

        ScriptApp.newTrigger('resumeBatchSend')
          .timeBased()
          .after(60 * 1000) // resume in 1 minute
          .create();

        return {
          success: true,
          message: `Sent ${sentCount} emails so far. Batch will resume automatically in ~1 minute (timeout management).`
        };
      }

      const row = data[i];

      // Skip completely empty rows
      if (row.every(cell => !cell || String(cell).trim() === '')) {
        continue;
      }

      const status = row[statusColIndex];
      const email = String(row[emailColIndex]).trim();

      // Skip previously sent or missing email
      if (!email || (status && status !== '')) {
        continue;
      }

      // Basic email syntax validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        sheet.getRange(i + 2, statusColIndex + 1).setValue('Invalid Email');
        continue;
      }

      // Skip if out of quota
      if (MailApp.getRemainingDailyQuota() < 1) {
        return { success: false, message: `Sent ${sentCount} emails but ran out of quota.` };
      }

      // Process variables
      const subject = replaceVariables(msg.getSubject(), headers, row);
      let htmlBody = replaceVariables(msg.getBody(), headers, row);
      const plainBody = replaceVariables(msg.getPlainBody(), headers, row);

      // Append tracking pixel if URL is provided
      if (config.webAppUrl) {
        const sheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
        const sheetName = encodeURIComponent(sheet.getName());
        const pixelUrl = `${config.webAppUrl}?sheetId=${sheetId}&sheetName=${sheetName}&row=${i + 2}&t=${Date.now()}`;
        const safePixelUrl = pixelUrl.replace(/&/g, '&amp;');
        const imgTag = `<img src="${safePixelUrl}" alt="" width="1" height="1" border="0" />`;

        if (htmlBody.toLowerCase().includes('</body>')) {
          htmlBody = htmlBody.replace(/<\/body>/i, imgTag + '</body>');
        } else {
          htmlBody += imgTag;
        }
      }

      // Build MIME message with tracking headers
      const raw = buildMimeMessage({
        to: email,
        from: senderEmail,
        senderName: config.senderName || '',
        replyTo: config.replyTo || '',
        subject: subject,
        plainBody: plainBody,
        htmlBody: htmlBody,
        attachments: attachments,
        inlineContentIds: inlineContentIds,
        customHeaders: {
          'X-Campaign-ID': campaignId,
          'X-Row-ID': String(i + 2)
        }
      });

      try {
        Gmail.Users.Messages.send({ raw: raw }, 'me');
        sheet.getRange(i + 2, statusColIndex + 1).setValue('Sent');
        sentCount++;
      } catch (e) {
        sheet.getRange(i + 2, statusColIndex + 1).setValue('Error: ' + e.message);
      }
    }

    // Clean up resumption state on completion
    PropertiesService.getDocumentProperties().deleteProperty(CONFIG.KEYS.LAST_PROCESSED_ROW);
    PropertiesService.getDocumentProperties().deleteProperty(CONFIG.KEYS.BATCH_CONFIG);

    // Enable background scanning since toggle is removed
    setupAnalyticsTrigger();

    return { success: true, message: `Successfully sent ${sentCount} emails.` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Invoked by a time-driven trigger to resume a batch that was paused due to
 * the Apps Script 6-minute execution limit.
 * Reads saved state from PropertiesService, deletes the trigger, and continues.
 */
function resumeBatchSend() {
  // Delete the trigger that called us so it doesn't re-fire
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'resumeBatchSend') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Retrieve saved state
  const lastRow = getProperty(CONFIG.KEYS.LAST_PROCESSED_ROW);
  const configJson = getProperty(CONFIG.KEYS.BATCH_CONFIG);

  if (!lastRow || !configJson) {
    console.log('resumeBatchSend: No saved state found. Nothing to resume.');
    return;
  }

  const config = JSON.parse(configJson);
  const startRowIndex = parseInt(lastRow, 10);

  console.log('resumeBatchSend: Resuming from row index ' + startRowIndex);
  const result = sendBatchEmails(config, startRowIndex);
  console.log('resumeBatchSend result: ' + JSON.stringify(result));
}
