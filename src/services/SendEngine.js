/**
 * Core engine for sending emails via Advanced Gmail API.
 * Uses MimeBuilder.js for raw MIME construction with custom header injection.
 */

// Maximum safe execution time in milliseconds (4 min 30 sec of the 6-min limit)
const MAX_EXECUTION_MS = 270000;

/**
 * Extracts Google Drive file IDs from plain text or rich text hyperlinks.
 * @param {string} cellValue The raw cell value
 * @param {GoogleAppsScript.Spreadsheet.RichTextValue} [richTextValue] Optional rich text value to extract hyperlinks
 * @returns {Array<string>} Array of file IDs
 */
function extractDriveFileIds_(cellValue, richTextValue) {
  const ids = new Set();

  const extractId = (str) => {
    if (!str) return null;
    const match = str.match(/(?:id=|d\/|open\?id=)([-\w]{25,})/i);
    if (match) return match[1];
    const exactMatch = str.match(/^[-\w]{25,}$/);
    if (exactMatch) return exactMatch[0];
    const looseMatch = str.match(/[-\w]{25,}/);
    if (looseMatch && (str.includes('drive.google.com') || str.includes('docs.google.com'))) {
      return looseMatch[0];
    }
    return null;
  };

  if (richTextValue) {
    const runs = richTextValue.getRuns();
    runs.forEach((run) => {
      const url = run.getLinkUrl();
      if (url) {
        const id = extractId(url);
        if (id) ids.add(id);
      }
    });
  }

  if (cellValue) {
    const parts = String(cellValue).split(',');
    parts.forEach((part) => {
      const id = extractId(part.trim());
      if (id) ids.add(id);
    });
  }

  return Array.from(ids);
}

/**
 * Parallel pre-fetches Google Drive files as Blobs given an array of unique IDs.
 * Utilizes UrlFetchApp.fetchAll for massive performance improvements.
 * @param {Array<string>} fileIds Array of unique Drive file IDs
 * @returns {Object} Map of fileId -> GoogleAppsScript.Base.Blob
 */
function prefetchDriveAttachments_(fileIds) {
  const prefetchMap = {};
  if (!fileIds || fileIds.length === 0) return prefetchMap;

  const token = ScriptApp.getOAuthToken();

  // 1. Fetch Metadata in parallel
  const metaRequests = fileIds.map((id) => ({
    url: `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType`,
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  }));

  const metaResponses = callWithBackoff(() => UrlFetchApp.fetchAll(metaRequests));

  const validIds = [];
  const metaDataMap = {};

  metaResponses.forEach((res, index) => {
    const id = fileIds[index];
    if (res.getResponseCode() === 200) {
      const metadata = JSON.parse(res.getContentText());
      const mimeType = metadata.mimeType;

      if (
        mimeType === 'application/vnd.google-apps.folder' ||
        mimeType === 'application/vnd.google-apps.shortcut' ||
        mimeType.startsWith('application/vnd.google-apps.')
      ) {
        console.warn(`File ${id} is unsupported or a Google Doc (${mimeType})`);
      } else {
        validIds.push(id);
        metaDataMap[id] = metadata;
      }
    } else {
      console.warn(`Failed metadata fetch for ${id}: ${res.getContentText()}`);
    }
  });

  if (validIds.length === 0) return prefetchMap;

  // 2. Fetch Media in parallel
  const mediaRequests = validIds.map((id) => ({
    url: `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
    method: 'get',
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true
  }));

  // Chunking to avoid URLFetchApp limits (safe max is generally ~30-50 concurrent requests depending on size)
  const CHUNK_SIZE = 30;
  for (let i = 0; i < validIds.length; i += CHUNK_SIZE) {
    const chunkIds = validIds.slice(i, i + CHUNK_SIZE);
    const chunkRequests = mediaRequests.slice(i, i + CHUNK_SIZE);

    const mediaResponses = callWithBackoff(() => UrlFetchApp.fetchAll(chunkRequests));

    mediaResponses.forEach((res, index) => {
      const id = chunkIds[index];
      if (res.getResponseCode() === 200) {
        const blob = res.getBlob();
        const meta = metaDataMap[id];
        blob.setName(meta.name);
        blob.setContentType(meta.mimeType);
        prefetchMap[id] = blob;
      } else {
        console.warn(`Failed media fetch for ${id}: ${res.getContentText()}`);
      }
    });
  }

  return prefetchMap;
}

/**
 * Fetches Google Drive files as Blobs given their IDs.
 * Utilizes prefetchDriveAttachments_ for backwards compatibility in synchronous contexts.
 * @param {Array<string>} ids Array of Drive file IDs
 * @returns {Array<GoogleAppsScript.Base.Blob>} Array of Blobs
 */
function getBlobsFromFileIds_(ids) {
  const prefetched = prefetchDriveAttachments_(ids);
  return ids.map((id) => prefetched[id]).filter((blob) => blob !== undefined);
}

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
    const escapedHeader = header.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp('\\{\\{\\s*' + escapedHeader + '\\s*\\}\\}', 'gi');
    const replacement =
      rowData[index] !== undefined && rowData[index] !== null ? String(rowData[index]) : '';
    result = result.replace(regex, replacement);
  });
  return result;
}

/**
 * Generates a unique campaign ID for tracking.
 * @returns {string} e.g. "camp_abc123_1711234567890"
 */
function generateCampaignId_(sheetId) {
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

    // Look for explicit CC/BCC/Attachment columns
    const ccColIndex = headers.findIndex((h) => String(h).trim().toLowerCase() === 'cc');
    const bccColIndex = headers.findIndex((h) => String(h).trim().toLowerCase() === 'bcc');
    const attachmentColIndex = headers.findIndex((h) => {
      const name = String(h).trim().toLowerCase();
      return name === 'attachment' || name === 'attachments';
    });

    // Process templates, falling back to Draft CC/BCC if columns are empty or don't exist
    const subject = replaceVariables(msg.getSubject(), headers, testRow);
    const htmlBody = replaceVariables(msg.getBody(), headers, testRow);
    const plainBody = replaceVariables(msg.getPlainBody(), headers, testRow);

    let cc = ccColIndex !== -1 && testRow[ccColIndex] ? String(testRow[ccColIndex]).trim() : '';
    if (!cc) cc = replaceVariables(msg.getCc(), headers, testRow);

    let bcc = bccColIndex !== -1 && testRow[bccColIndex] ? String(testRow[bccColIndex]).trim() : '';
    if (!bcc) bcc = replaceVariables(msg.getBcc(), headers, testRow);

    // The recipient is the active user for tests
    const recipient = Session.getActiveUser().getEmail();
    const senderEmail = config.senderAlias || recipient;

    // Extract inline image Content-IDs from the draft
    const inlineContentIds = getInlineContentIds_(msg.getId());
    let attachments = msg.getAttachments({ includeInlineImages: true });

    // Process personalized attachments from the spreadsheet
    if (attachmentColIndex !== -1) {
      const cellValue = testRow[attachmentColIndex];
      let richTextValue = null;
      if (cellValue && !String(cellValue).startsWith('#')) {
        try {
          richTextValue = sheet.getRange(2, attachmentColIndex + 1).getRichTextValue();
        } catch (e) {
          console.warn('Failed to read rich text for test email attachment', e);
        }
      }
      const ids = extractDriveFileIds_(cellValue, richTextValue);
      if (ids.length > 0) {
        const customBlobs = getBlobsFromFileIds_(ids);
        attachments = attachments.concat(customBlobs);
      }
    }

    // Build MIME message with custom tracking headers
    const raw = buildMimeMessage({
      to: recipient,
      from: senderEmail,
      senderName: config.senderName || '',
      replyTo: config.replyTo || '',
      subject: subject,
      plainBody: plainBody,
      htmlBody: htmlBody,
      cc: cc,
      bcc: bcc,
      attachments: attachments,
      inlineContentIds: inlineContentIds,
      customHeaders: {
        'X-Campaign-ID': 'TEST',
        'X-Row-ID': '2'
      }
    });

    callWithBackoff(() => Gmail.Users.Messages.send({ raw: raw }, 'me'));

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
 * @param {boolean} [isUiContext] Whether the call is made from the synchronous UI (to apply 25s timeout)
 * @returns {Object} {success: boolean, message: string}
 */
function sendBatchEmails(config, startRow, isUiContext = false) {
  try {
    if ((!startRow || startRow === 0) && typeof cleanupOrphanedTriggers === 'function') {
      cleanupOrphanedTriggers();
    }

    // Save state in case of UI reload
    setProperty(CONFIG.KEYS.SELECTED_DRAFT_ID, config.draftId);
    setProperty(CONFIG.KEYS.SENDER_NAME, config.senderName || '');
    setProperty(CONFIG.KEYS.SENDER_ALIAS, config.senderAlias || '');
    setProperty(CONFIG.KEYS.REPLY_TO, config.replyTo || '');
    setProperty(CONFIG.KEYS.EMAIL_COLUMN, config.emailColumn);

    // Check quota
    const quota = MailApp.getRemainingDailyQuota();
    if (quota < 1) {
      throw new Error('You have reached your daily Google email quota limit.');
    }

    let spreadsheet;
    let sheet;
    if (config.spreadsheetId && config.sheetName) {
      spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
      sheet = spreadsheet.getSheetByName(config.sheetName);
    } else {
      spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      sheet = SpreadsheetApp.getActiveSheet();
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('No data available to send.');

    // Pre-flight validation
    const validation = validateTemplate(config.draftId, sheet);
    if (!validation.isValid) {
      return {
        success: false,
        message: 'Validation failed. Missing columns: ' + validation.missingColumns.join(', ')
      };
    }

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    // Determine which columns are email and merge status
    const emailColIndex = headers.indexOf(config.emailColumn);
    let statusColIndex = headers.findIndex((h) => String(h).toLowerCase() === 'merge status');

    const ccColIndex = headers.findIndex((h) => String(h).trim().toLowerCase() === 'cc');
    const bccColIndex = headers.findIndex((h) => String(h).trim().toLowerCase() === 'bcc');
    const attachmentColIndex = headers.findIndex((h) => {
      const name = String(h).trim().toLowerCase();
      return name === 'attachment' || name === 'attachments';
    });

    if (emailColIndex === -1) throw new Error('Email column not found.');
    if (statusColIndex === -1) {
      statusColIndex = headers.length;
      sheet
        .getRange(1, statusColIndex + 1)
        .setValue('Merge status')
        .setFontWeight('bold');
    }

    const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
    const data = dataRange.getValues();

    let attachmentRichTextData = null;
    if (attachmentColIndex !== -1) {
      try {
        attachmentRichTextData = sheet
          .getRange(2, attachmentColIndex + 1, lastRow - 1, 1)
          .getRichTextValues();
      } catch (e) {
        console.warn(
          'Bulk getRichTextValues failed, likely due to a formula error in the column. Falling back to row-by-row fetching for valid cells.',
          e
        );
      }
    }

    // Calculate total valid rows to process
    let totalToSend = 0;
    for (let j = 0; j < data.length; j++) {
      // Skip hidden rows
      if (sheet.isRowHiddenByUser(j + 2) || sheet.isRowHiddenByFilter(j + 2)) continue;

      const row = data[j];
      if (row.every((cell) => !cell || String(cell).trim() === '')) continue;
      const status = row[statusColIndex];
      const email = String(row[emailColIndex]).trim();
      if (!email || (status && status !== '')) continue;
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) continue;
      totalToSend++;
    }

    if (totalToSend === 0) {
      return { success: false, message: 'No valid rows found to send. Please check your data.' };
    }

    if (quota < totalToSend) {
      return {
        success: false,
        message: `Insufficient Google email quota. You are trying to send ${totalToSend} emails, but your remaining daily quota is ${quota}.`
      };
    }

    // Initialize progress Cache
    const cache = CacheService.getDocumentCache();
    cache.put(
      CONFIG.KEYS.PROGRESS_CACHE,
      JSON.stringify({ current: 0, total: totalToSend, status: 'sending' }),
      600
    );

    const draft = GmailApp.getDraft(config.draftId);
    if (!draft) throw new Error('Draft not found.');
    const msg = draft.getMessage();
    const inlineContentIds = getInlineContentIds_(msg.getId());
    const attachments = msg.getAttachments({ includeInlineImages: true });

    // Generate or retrieve campaign ID
    let campaignId;
    let campaignLabelId = null;

    if (startRow && startRow > 0) {
      campaignId = getProperty(CONFIG.KEYS.CAMPAIGN_ID);
      campaignLabelId = getProperty(CONFIG.KEYS.CAMPAIGN_LABEL_ID);
    }
    if (!campaignId) {
      const currentSheetId = config.spreadsheetId || spreadsheet.getId();
      campaignId = generateCampaignId_(currentSheetId);
      setProperty(CONFIG.KEYS.CAMPAIGN_ID, campaignId);

      // Setup Campaign Label based on subject
      const originalSubject = msg.getSubject() || 'Untitled Campaign';
      let labelName = 'UNAVSA - ' + originalSubject.trim().substring(0, 100);
      labelName = labelName.replace(/[/\\:*?"<>|]/g, '').trim(); // Sanitize invalid label characters

      try {
        const labelsList = Gmail.Users.Labels.list('me');
        const existingLabel = labelsList.labels.find((l) => l.name === labelName);
        if (existingLabel) {
          campaignLabelId = existingLabel.id;
        } else {
          const createdLabel = Gmail.Users.Labels.create({ name: labelName }, 'me');
          campaignLabelId = createdLabel.id;
        }
        setProperty(CONFIG.KEYS.CAMPAIGN_LABEL, labelName);
        setProperty(CONFIG.KEYS.CAMPAIGN_LABEL_ID, campaignLabelId);
      } catch (e) {
        console.error('Failed to setup campaign label', e);
      }
    }

    const senderEmail = config.senderAlias || Session.getActiveUser().getEmail();
    let sentCount = 0;
    const loopStart = startRow || 0;

    // --- PARALLEL PRE-FETCHING ---
    // Scan all valid rows to collect unique Google Drive File IDs
    const allFileIds = new Set();
    if (attachmentColIndex !== -1) {
      for (let j = loopStart; j < data.length; j++) {
        if (sheet.isRowHiddenByUser(j + 2) || sheet.isRowHiddenByFilter(j + 2)) continue;
        const row = data[j];
        if (row.every((cell) => !cell || String(cell).trim() === '')) continue;
        const status = row[statusColIndex];
        const email = String(row[emailColIndex]).trim();
        if (!email || (status && status !== '')) continue;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) continue;

        const cellValue = row[attachmentColIndex];
        let richTextValue = null;
        if (attachmentRichTextData && attachmentRichTextData.length > j) {
          richTextValue = attachmentRichTextData[j][0];
        } else if (cellValue && !String(cellValue).startsWith('#')) {
          try {
            richTextValue = sheet.getRange(j + 2, attachmentColIndex + 1).getRichTextValue();
          } catch (e) {}
        }
        const ids = extractDriveFileIds_(cellValue, richTextValue);
        ids.forEach((id) => allFileIds.add(id));
      }
    }

    // Execute parallel Drive API requests to download attachments
    const prefetchedBlobs = prefetchDriveAttachments_(Array.from(allFileIds));
    // -----------------------------

    const executionStart = Date.now();
    const timeoutThreshold = isUiContext ? 25000 : MAX_EXECUTION_MS; // 25s for UI, 4.5m for triggers

    for (let i = loopStart; i < data.length; i++) {
      // ---- Timeout guard ----
      if (Date.now() - executionStart > timeoutThreshold) {
        // Save state and schedule continuation
        setProperty(CONFIG.KEYS.LAST_PROCESSED_ROW, String(i));
        setProperty(CONFIG.KEYS.BATCH_CONFIG, JSON.stringify(config));

        ScriptApp.newTrigger('resumeBatchSend')
          .timeBased()
          .after(60 * 60 * 1000) // resume in 1 hour due to Add-on limitations
          .create();

        cache.put(
          CONFIG.KEYS.PROGRESS_CACHE,
          JSON.stringify({ current: sentCount, total: totalToSend, status: 'paused' }),
          7200
        );

        return {
          success: true,
          message: `Sent ${sentCount} emails so far. Batch will resume automatically in ~1 hour (timeout management).`,
          sentCount: sentCount,
          total: totalToSend,
          status: 'paused'
        };
      }

      // Skip hidden rows
      if (sheet.isRowHiddenByUser(i + 2) || sheet.isRowHiddenByFilter(i + 2)) continue;

      const row = data[i];

      // Skip completely empty rows
      if (row.every((cell) => !cell || String(cell).trim() === '')) {
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

      let cc = ccColIndex !== -1 && row[ccColIndex] ? String(row[ccColIndex]).trim() : '';
      if (!cc) cc = replaceVariables(msg.getCc(), headers, row);

      let bcc = bccColIndex !== -1 && row[bccColIndex] ? String(row[bccColIndex]).trim() : '';
      if (!bcc) bcc = replaceVariables(msg.getBcc(), headers, row);

      let currentAttachments = [...attachments];
      if (attachmentColIndex !== -1) {
        const cellValue = row[attachmentColIndex];
        let richTextValue = null;

        if (attachmentRichTextData && attachmentRichTextData.length > i) {
          richTextValue = attachmentRichTextData[i][0];
        } else if (cellValue && !String(cellValue).startsWith('#')) {
          // Fallback row-by-row if bulk fetch failed (and cell is not an error)
          try {
            richTextValue = sheet.getRange(i + 2, attachmentColIndex + 1).getRichTextValue();
          } catch (e) {
            console.warn('Row-level getRichTextValue failed for row ' + (i + 2), e);
          }
        }

        const ids = extractDriveFileIds_(cellValue, richTextValue);
        if (ids.length > 0) {
          const customBlobs = ids
            .map((id) => prefetchedBlobs[id])
            .filter((blob) => blob !== undefined);
          currentAttachments = currentAttachments.concat(customBlobs);
        }
      }

      const trackingId = Utilities.getUuid();
      callWithBackoff(() =>
        sheet.getRange(i + 2, emailColIndex + 1).setNote('Tracking ID: ' + trackingId)
      );

      // Append tracking pixel if central tracking is configured
      if (CONFIG.TRACKING.CENTRAL_URL && CONFIG.TRACKING.SECRET_KEY) {
        const sheetId = config.spreadsheetId || spreadsheet.getId();
        const sheetName = encodeURIComponent(config.sheetName || sheet.getName());
        const rowNum = i + 2;

        let col = statusColIndex;
        let colLetters = '';
        while (col >= 0) {
          colLetters = String.fromCharCode(65 + (col % 26)) + colLetters;
          col = Math.floor(col / 26) - 1;
        }
        const cell = `${colLetters}${rowNum}`;
        const user = Session.getActiveUser().getEmail();

        const ts = Date.now();
        const payload = JSON.stringify({
          sheetId,
          sheetName: sheet.getName(),
          cell,
          user,
          ts,
          tid: trackingId
        });
        const sig = Utilities.base64EncodeWebSafe(
          Utilities.computeHmacSha256Signature(payload, CONFIG.TRACKING.SECRET_KEY)
        );

        const pixelUrl = `${CONFIG.TRACKING.CENTRAL_URL}?sheetId=${sheetId}&sheetName=${sheetName}&cell=${cell}&user=${encodeURIComponent(user)}&ts=${ts}&tid=${trackingId}&sig=${sig}`;
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
        cc: cc,
        bcc: bcc,
        attachments: currentAttachments,
        inlineContentIds: inlineContentIds,
        customHeaders: {
          'X-Campaign-ID': campaignId,
          'X-Row-ID': String(i + 2),
          'X-Tracking-ID': trackingId
        }
      });

      try {
        const sentMessage = callWithBackoff(() => Gmail.Users.Messages.send({ raw: raw }, 'me'));

        if (campaignLabelId) {
          try {
            callWithBackoff(() =>
              Gmail.Users.Messages.modify({ addLabelIds: [campaignLabelId] }, 'me', sentMessage.id)
            );
          } catch (labelErr) {
            console.error('Failed to label message', labelErr);
          }
        }

        const tz = spreadsheet.getSpreadsheetTimeZone() || 'GMT';
        const timeString = Utilities.formatDate(new Date(), tz, 'MM/dd HH:mm z');
        callWithBackoff(() => {
          const range = sheet.getRange(i + 2, statusColIndex + 1);
          range.setValue('Email sent');
          const existingNote = range.getNote() || '';
          const newNote = `Sent: ${timeString}`;
          range.setNote(existingNote ? existingNote + '\n' + newNote : newNote);
        });
        sentCount++;
        // Update Cache periodically
        cache.put(
          CONFIG.KEYS.PROGRESS_CACHE,
          JSON.stringify({ current: sentCount, total: totalToSend, status: 'sending' }),
          600
        );
      } catch (e) {
        callWithBackoff(() => {
          const range = sheet.getRange(i + 2, statusColIndex + 1);
          range.setValue('Error');
          const existingNote = range.getNote() || '';
          const newNote = `Error: ${e.message}`;
          range.setNote(existingNote ? existingNote + '\n' + newNote : newNote);
        });
      }
    }

    // Clean up resumption state on completion
    PropertiesService.getDocumentProperties().deleteProperty(CONFIG.KEYS.LAST_PROCESSED_ROW);
    PropertiesService.getDocumentProperties().deleteProperty(CONFIG.KEYS.BATCH_CONFIG);

    // Update progress on completion
    cache.put(
      CONFIG.KEYS.PROGRESS_CACHE,
      JSON.stringify({ current: sentCount, total: totalToSend, status: 'complete' }),
      600
    );

    // Enable background scanning since toggle is removed
    setupAnalyticsTrigger();

    return {
      success: true,
      message: `Successfully sent ${sentCount} emails.`,
      sentCount: sentCount,
      total: totalToSend
    };
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
  try {
    // Delete the trigger that called us so it doesn't re-fire
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('resumeBatchSend');
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'resumeBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

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
  } catch (err) {
    if (typeof ErrorLib !== 'undefined') ErrorLib.logError(err, 'resumeBatchSend');
    console.error('resumeBatchSend crashed: ', err);
  }
}

/**
 * Reads the current progress from CacheService.
 * @returns {Object} JSON object with current, total, and status
 */
function getMergeProgress() {
  const cache = CacheService.getDocumentCache();
  const progressStr = cache.get(CONFIG.KEYS.PROGRESS_CACHE);
  if (!progressStr) {
    return { current: 0, total: 0, status: 'idle' };
  }
  return JSON.parse(progressStr);
}

/**
 * Starts an immediate batch send in the background to unblock the UI.
 * @param {Object} config The settings from the UI
 * @returns {Object} {success: boolean, message: string}
 */
function startBackgroundBatchEmails(config) {
  try {
    if (typeof cleanupOrphanedTriggers === 'function') cleanupOrphanedTriggers();

    let sheet;
    if (config.spreadsheetId && config.sheetName) {
      sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.sheetName);
    } else {
      sheet = SpreadsheetApp.getActiveSheet();
    }

    // Pre-flight validation
    const validation = validateTemplate(config.draftId, sheet);
    if (!validation.isValid) {
      return {
        success: false,
        message: 'Validation failed. Missing columns: ' + validation.missingColumns.join(', ')
      };
    }

    // Save the config for the background run
    setProperty(CONFIG.KEYS.BATCH_CONFIG, JSON.stringify(config));

    // Clear any existing background triggers for immediate send
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('runBackgroundBatchSend');
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'runBackgroundBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    // Create the trigger to fire almost immediately (1 millisecond)
    ScriptApp.newTrigger('runBackgroundBatchSend').timeBased().after(1).create();

    return {
      success: true,
      message: 'Batch sending started in the background. You can close this sidebar.'
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Trigger handler for the immediate background batch send.
 */
function runBackgroundBatchSend() {
  try {
    // Delete the trigger that called us
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('runBackgroundBatchSend');
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'runBackgroundBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    // Retrieve saved configuration
    const configJson = getProperty(CONFIG.KEYS.BATCH_CONFIG);
    if (!configJson) {
      console.log('runBackgroundBatchSend: No config found.');
      return;
    }

    const config = JSON.parse(configJson);

    console.log('runBackgroundBatchSend: Starting background batch send.');
    const result = sendBatchEmails(config, 0); // isUiContext defaults to false
    console.log('runBackgroundBatchSend result: ' + JSON.stringify(result));
  } catch (err) {
    if (typeof ErrorLib !== 'undefined') ErrorLib.logError(err, 'runBackgroundBatchSend');
    console.error('runBackgroundBatchSend crashed: ', err);
  }
}

/**
 * Schedules a batch of emails to be sent at a future date and time.
 * @param {Object} config The settings from the UI
 * @returns {Object} {success: boolean, message: string}
 */
function scheduleBatchEmails(config) {
  try {
    if (typeof cleanupOrphanedTriggers === 'function') cleanupOrphanedTriggers();

    const scheduleTime = new Date(config.scheduleDate).getTime();
    const now = Date.now();
    // Allow a 60-second grace period for "future" checks to account for UI lag/clock drift
    if (scheduleTime <= now - 60000) {
      throw new Error('Scheduled time must be in the future.');
    }

    let sheet;
    if (config.spreadsheetId && config.sheetName) {
      sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(config.sheetName);
    } else {
      sheet = SpreadsheetApp.getActiveSheet();
    }

    // Pre-flight validation
    const validation = validateTemplate(config.draftId, sheet);
    if (!validation.isValid) {
      return {
        success: false,
        message: 'Validation failed. Missing columns: ' + validation.missingColumns.join(', ')
      };
    }

    // Save the config for the scheduled run
    setProperty(CONFIG.KEYS.SCHEDULED_BATCH_CONFIG, JSON.stringify(config));

    // Clear any existing scheduled triggers just in case (single campaign assumption)
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('startScheduledBatchSend');
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'startScheduledBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    // Persist user timezone so it can be referenced later if needed
    if (config.userTimezone) {
      setProperty(CONFIG.KEYS.USER_TIMEZONE, config.userTimezone);
    }

    // Create the trigger
    ScriptApp.newTrigger('startScheduledBatchSend').timeBased().at(new Date(scheduleTime)).create();

    // Format the time in the user's local timezone for the confirmation toast
    const displayTz =
      config.userTimezone ||
      SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() ||
      Session.getScriptTimeZone();
    const formattedDate = Utilities.formatDate(
      new Date(scheduleTime),
      displayTz,
      "EEEE, MMMM d, yyyy 'at' h:mm a z"
    );
    return { success: true, message: `Campaign successfully scheduled for ${formattedDate}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Invoked by a time-driven trigger to start a scheduled batch.
 */
function startScheduledBatchSend() {
  try {
    // Delete the trigger that called us
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('startScheduledBatchSend');
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'startScheduledBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    // Retrieve saved configuration
    const configJson = getProperty(CONFIG.KEYS.SCHEDULED_BATCH_CONFIG);
    if (!configJson) {
      console.log('startScheduledBatchSend: No scheduled config found.');
      return;
    }

    const config = JSON.parse(configJson);
    PropertiesService.getDocumentProperties().deleteProperty(CONFIG.KEYS.SCHEDULED_BATCH_CONFIG);

    console.log('startScheduledBatchSend: Starting scheduled batch send.');
    const result = sendBatchEmails(config, 0);
    console.log('startScheduledBatchSend result: ' + JSON.stringify(result));
  } catch (err) {
    if (typeof ErrorLib !== 'undefined') ErrorLib.logError(err, 'startScheduledBatchSend');
    console.error('startScheduledBatchSend crashed: ', err);
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    replaceVariables,
    sendBatchEmails,
    sendTestEmail,
    scheduleBatchEmails,
    startBackgroundBatchEmails
  };
}
