/**
 * Core engine for sending emails via Advanced Gmail API.
 * Uses MimeBuilder.js for raw MIME construction with custom header injection.
 */

// Maximum safe execution time in milliseconds (4 min 30 sec of the 6-min limit)
const MAX_EXECUTION_MS = 270000;
const SEND_BURST_SIZE = 20;
const BURST_TIMEOUT_BUFFER_MS = 10000;
const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pre-calculates hidden/filtered rows once so the hot send loop can stay in-memory.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowCount Number of data rows starting at sheet row 2
 * @returns {Array<boolean>} 0-based array aligned to the data rows
 */
function buildHiddenRowMap_(sheet, rowCount) {
  const hiddenRows = [];
  for (let i = 0; i < rowCount; i++) {
    const rowNumber = i + 2;
    hiddenRows[i] = sheet.isRowHiddenByUser(rowNumber) || sheet.isRowHiddenByFilter(rowNumber);
  }
  return hiddenRows;
}

/**
 * Converts a zero-based column index into spreadsheet letters.
 * @param {number} zeroBasedColumnIndex
 * @returns {string}
 */
function toColumnLetters_(zeroBasedColumnIndex) {
  let col = zeroBasedColumnIndex;
  let letters = '';
  while (col >= 0) {
    letters = String.fromCharCode(65 + (col % 26)) + letters;
    col = Math.floor(col / 26) - 1;
  }
  return letters;
}

/**
 * Appends a line to an existing note without losing previous content.
 * @param {string} existingNote
 * @param {string} newLine
 * @returns {string}
 */
function appendNoteLine_(existingNote, newLine) {
  return existingNote ? existingNote + '\n' + newLine : newLine;
}

/**
 * Tracks the smallest dirty row window for buffered sheet writes.
 * @param {{start: (number|null), end: (number|null)}} dirtyWindow
 * @param {number} rowIndex
 */
function markDirtyRow_(dirtyWindow, rowIndex) {
  if (dirtyWindow.start === null || rowIndex < dirtyWindow.start) {
    dirtyWindow.start = rowIndex;
  }
  if (dirtyWindow.end === null || rowIndex > dirtyWindow.end) {
    dirtyWindow.end = rowIndex;
  }
}

/**
 * Flushes the buffered values/notes for the modified row window.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} statusColIndex
 * @param {number} emailColIndex
 * @param {Array<Array<string>>} statusValues
 * @param {Array<Array<string>>} statusNotes
 * @param {Array<Array<string>>} emailNotes
 * @param {{start: (number|null), end: (number|null)}} dirtyWindow
 */
function flushBufferedSheetUpdates_(
  sheet,
  statusColIndex,
  emailColIndex,
  statusValues,
  statusNotes,
  emailNotes,
  dirtyWindow
) {
  if (dirtyWindow.start === null || dirtyWindow.end === null) return;

  const startRow = dirtyWindow.start + 2;
  const rowCount = dirtyWindow.end - dirtyWindow.start + 1;

  callWithBackoff(() => {
    sheet
      .getRange(startRow, statusColIndex + 1, rowCount, 1)
      .setValues(statusValues.slice(dirtyWindow.start, dirtyWindow.end + 1));
    sheet
      .getRange(startRow, statusColIndex + 1, rowCount, 1)
      .setNotes(statusNotes.slice(dirtyWindow.start, dirtyWindow.end + 1));
    sheet
      .getRange(startRow, emailColIndex + 1, rowCount, 1)
      .setNotes(emailNotes.slice(dirtyWindow.start, dirtyWindow.end + 1));
  });

  dirtyWindow.start = null;
  dirtyWindow.end = null;
}

/**
 * Merges buffered send results with any tracker updates that may have landed first.
 * This prevents a fast open ping from being overwritten back to "Email sent".
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} statusColIndex
 * @param {Array<Array<string>>} statusValues
 * @param {Array<Array<string>>} statusNotes
 * @param {{start: (number|null), end: (number|null)}} dirtyWindow
 */
function mergeExistingStatusWindow_(sheet, statusColIndex, statusValues, statusNotes, dirtyWindow) {
  if (dirtyWindow.start === null || dirtyWindow.end === null) return;

  const startRow = dirtyWindow.start + 2;
  const rowCount = dirtyWindow.end - dirtyWindow.start + 1;
  const existingValues = sheet.getRange(startRow, statusColIndex + 1, rowCount, 1).getValues();
  const existingNotes = sheet.getRange(startRow, statusColIndex + 1, rowCount, 1).getNotes();

  for (let offset = 0; offset < rowCount; offset++) {
    const rowIndex = dirtyWindow.start + offset;
    const existingValue = String(existingValues[offset][0] || '');
    const existingNote = existingNotes[offset][0] || '';
    const bufferedValue = String(statusValues[rowIndex][0] || '');
    const bufferedNote = statusNotes[rowIndex][0] || '';
    const lower = existingValue.toLowerCase();

    if (lower.includes('opened') || lower.includes('replied') || lower.includes('bounced')) {
      statusValues[rowIndex][0] = existingValue;
      statusNotes[rowIndex][0] = existingNote;

      if (bufferedValue === 'Email sent' && bufferedNote && existingNote.indexOf('Sent: ') === -1) {
        statusNotes[rowIndex][0] = appendNoteLine_(statusNotes[rowIndex][0], bufferedNote);
      }
    }
  }
}

/**
 * Builds a Gmail API send request for UrlFetchApp.fetchAll.
 * @param {string} oauthToken
 * @param {string} rawMessage
 * @returns {Object}
 */
function buildGmailSendRequest_(oauthToken, rawMessage) {
  return {
    url: GMAIL_SEND_ENDPOINT,
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: `Bearer ${oauthToken}` },
    payload: JSON.stringify({ raw: rawMessage }),
    muteHttpExceptions: true
  };
}

/**
 * Builds a Gmail API modify request that applies the campaign label to a sent message.
 * @param {string} oauthToken
 * @param {string} messageId
 * @param {string} campaignLabelId
 * @returns {Object}
 */
function buildGmailModifyLabelRequest_(oauthToken, messageId, campaignLabelId) {
  return {
    url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: `Bearer ${oauthToken}` },
    payload: JSON.stringify({ addLabelIds: [campaignLabelId] }),
    muteHttpExceptions: true
  };
}

/**
 * Extracts a readable Gmail API error message from an HTTP response body.
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response
 * @returns {string}
 */
function extractGmailSendError_(response) {
  const code = response.getResponseCode();
  const body = response.getContentText() || '';

  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.error) {
      if (parsed.error.message) {
        return `Gmail API ${code}: ${parsed.error.message}`;
      }
      if (parsed.error.errors && parsed.error.errors.length > 0 && parsed.error.errors[0].message) {
        return `Gmail API ${code}: ${parsed.error.errors[0].message}`;
      }
    }
  } catch {
    // Fall through to plain text handling.
  }

  return body ? `Gmail API ${code}: ${body}` : `Gmail API ${code}`;
}

/**
 * Determines whether a Gmail API send response should be retried.
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response
 * @returns {boolean}
 */
function isRetryableGmailSendResponse_(response) {
  const code = response.getResponseCode();
  if (code === 429 || code === 500 || code === 502 || code === 503 || code === 504) {
    return true;
  }
  if (code !== 403) {
    return false;
  }

  try {
    const parsed = JSON.parse(response.getContentText() || '{}');
    const reasons = (parsed.error && parsed.error.errors) || [];
    return reasons.some((item) => {
      const reason = item.reason || '';
      return (
        reason === 'rateLimitExceeded' ||
        reason === 'userRateLimitExceeded' ||
        reason === 'backendError'
      );
    });
  } catch {
    return false;
  }
}

/**
 * Sends a burst of Gmail API requests in parallel and retries only the failed subset.
 * @param {Array<Object>} burstEntries
 * @param {string} oauthToken
 * @returns {Array<Object>}
 */
function sendBurstRequests_(burstEntries, oauthToken) {
  const maxRetries = 5;
  const baseDelayMs = 1000;
  const results = new Array(burstEntries.length);
  let pending = burstEntries.map((entry, index) => ({ entry, index, attempt: 0 }));

  while (pending.length > 0) {
    const requests = pending.map((item) =>
      buildGmailSendRequest_(oauthToken, item.entry.raw)
    );
    const responses = callWithBackoff(() => UrlFetchApp.fetchAll(requests));
    const retryQueue = [];

    responses.forEach((response, responseIndex) => {
      const item = pending[responseIndex];
      const code = response.getResponseCode();

      if (code >= 200 && code < 300) {
        let messageId;
        try {
          const parsed = JSON.parse(response.getContentText() || '{}');
          messageId = parsed.id || null;
        } catch {
          messageId = null;
        }
        results[item.index] = { success: true, messageId };
        return;
      }

      if (isRetryableGmailSendResponse_(response) && item.attempt < maxRetries) {
        retryQueue.push({ entry: item.entry, index: item.index, attempt: item.attempt + 1 });
        return;
      }

      results[item.index] = {
        success: false,
        message: extractGmailSendError_(response)
      };
    });

    if (retryQueue.length === 0) {
      break;
    }

    const attempt = retryQueue.reduce((max, item) => Math.max(max, item.attempt), 0);
    const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
    Utilities.sleep(delay);
    pending = retryQueue;
  }

  return results;
}

/**
 * Applies the campaign label to successfully sent messages in parallel.
 * @param {Array<Object>} sendResults
 * @param {string} oauthToken
 * @param {string|null} campaignLabelId
 * @returns {Object<string, string>} Map of rowIndex -> label error message
 */
function applyCampaignLabelsToBurst_(sendResults, oauthToken, campaignLabelId) {
  const labelErrorsByRow = {};
  if (!campaignLabelId) return labelErrorsByRow;

  const targets = sendResults.filter((result) => result && result.success && result.messageId);
  if (targets.length === 0) return labelErrorsByRow;

  const maxRetries = 5;
  const baseDelayMs = 1000;
  let pending = targets.map((result, index) => ({ result, index, attempt: 0 }));

  while (pending.length > 0) {
    const requests = pending.map((item) =>
      buildGmailModifyLabelRequest_(oauthToken, item.result.messageId, campaignLabelId)
    );
    const responses = callWithBackoff(() => UrlFetchApp.fetchAll(requests));
    const retryQueue = [];

    responses.forEach((response, responseIndex) => {
      const item = pending[responseIndex];
      const code = response.getResponseCode();

      if (code >= 200 && code < 300) {
        return;
      }

      if (isRetryableGmailSendResponse_(response) && item.attempt < maxRetries) {
        retryQueue.push({ result: item.result, index: item.index, attempt: item.attempt + 1 });
        return;
      }

      labelErrorsByRow[item.result.rowIndex] = extractGmailSendError_(response);
    });

    if (retryQueue.length === 0) {
      break;
    }

    const attempt = retryQueue.reduce((max, item) => Math.max(max, item.attempt), 0);
    const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
    Utilities.sleep(delay);
    pending = retryQueue;
  }

  return labelErrorsByRow;
}

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
      cleanupOrphanedTriggers(config.spreadsheetId);
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
    const hiddenRows = buildHiddenRowMap_(sheet, data.length);

    const statusValues = sheet.getRange(2, statusColIndex + 1, data.length, 1).getValues();
    const statusNotes = sheet.getRange(2, statusColIndex + 1, data.length, 1).getNotes();
    const emailNotes = sheet.getRange(2, emailColIndex + 1, data.length, 1).getNotes();
    const dirtyWindow = { start: null, end: null };

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
      if (hiddenRows[j]) continue;

      const row = data[j];
      if (row.every((cell) => !cell || String(cell).trim() === '')) continue;
      const status = statusValues[j][0];
      const email = String(row[emailColIndex]).trim();
      if (!email || (status && status !== '')) continue;
      if (!EMAIL_REGEX.test(email)) continue;
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

    // Initialize progress Cache (user-scoped to prevent cross-user collisions)
    const cache = CacheService.getUserCache();
    cache.put(
      CONFIG.KEYS.PROGRESS_CACHE,
      JSON.stringify({ current: 0, total: totalToSend, status: 'sending' }),
      600
    );

    const draft = GmailApp.getDraft(config.draftId);
    if (!draft) throw new Error('Draft not found.');
    const msg = draft.getMessage();
    const subjectTemplate = msg.getSubject() || '';
    const htmlTemplate = msg.getBody() || '';
    const plainTemplate = msg.getPlainBody() || '';
    const ccTemplate = msg.getCc() || '';
    const bccTemplate = msg.getBcc() || '';
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
        const labelsList = callWithBackoff(() => Gmail.Users.Labels.list('me'));
        const existingLabel = labelsList.labels.find((l) => l.name === labelName);
        if (existingLabel) {
          campaignLabelId = existingLabel.id;
        } else {
          const createdLabel = callWithBackoff(() =>
            Gmail.Users.Labels.create({ name: labelName }, 'me')
          );
          campaignLabelId = createdLabel.id;
        }
        setProperty(CONFIG.KEYS.CAMPAIGN_LABEL, labelName);
        setProperty(CONFIG.KEYS.CAMPAIGN_LABEL_ID, campaignLabelId);
      } catch (e) {
        console.error('Failed to setup campaign label', e);
      }
    }

    const senderEmail = config.senderAlias || Session.getActiveUser().getEmail();
    const oauthToken = ScriptApp.getOAuthToken();
    const spreadsheetTimeZone = spreadsheet.getSpreadsheetTimeZone() || 'GMT';
    const statusColumnLetters = toColumnLetters_(statusColIndex);
    let sentCount = 0;
    const loopStart = startRow || 0;

    // --- PARALLEL PRE-FETCHING ---
    // Scan all valid rows to collect unique Google Drive File IDs
    const allFileIds = new Set();
    if (attachmentColIndex !== -1) {
      for (let j = loopStart; j < data.length; j++) {
        if (hiddenRows[j]) continue;
        const row = data[j];
        if (row.every((cell) => !cell || String(cell).trim() === '')) continue;
        const status = statusValues[j][0];
        const email = String(row[emailColIndex]).trim();
        if (!email || (status && status !== '')) continue;
        if (!EMAIL_REGEX.test(email)) continue;

        const cellValue = row[attachmentColIndex];
        let richTextValue = null;
        if (attachmentRichTextData && attachmentRichTextData.length > j) {
          richTextValue = attachmentRichTextData[j][0];
        } else if (cellValue && !String(cellValue).startsWith('#')) {
          try {
            richTextValue = sheet.getRange(j + 2, attachmentColIndex + 1).getRichTextValue();
          } catch (e) {
            console.warn('Prefetch: getRichTextValue failed for row ' + (j + 2), e);
          }
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
    let burstEntries = [];

    const flushBurst = () => {
      if (burstEntries.length === 0) {
        flushBufferedSheetUpdates_(
          sheet,
          statusColIndex,
          emailColIndex,
          statusValues,
          statusNotes,
          emailNotes,
          dirtyWindow
        );
        return;
      }

      const results = sendBurstRequests_(burstEntries, oauthToken);
      results.forEach((result, resultIndex) => {
        if (result && result.success) {
          result.rowIndex = burstEntries[resultIndex].rowIndex;
        }
      });
      const labelErrorsByRow = applyCampaignLabelsToBurst_(results, oauthToken, campaignLabelId);
      const sentTimeString = Utilities.formatDate(new Date(), spreadsheetTimeZone, 'MM/dd HH:mm z');

      results.forEach((result, resultIndex) => {
        const entry = burstEntries[resultIndex];
        if (result && result.success) {
          statusValues[entry.rowIndex][0] = 'Email sent';
          statusNotes[entry.rowIndex][0] = appendNoteLine_(
            statusNotes[entry.rowIndex][0],
            `Sent: ${sentTimeString}`
          );
          if (labelErrorsByRow[entry.rowIndex]) {
            statusNotes[entry.rowIndex][0] = appendNoteLine_(
              statusNotes[entry.rowIndex][0],
              `Label warning: ${labelErrorsByRow[entry.rowIndex]}`
            );
          }
          sentCount++;
        } else {
          statusValues[entry.rowIndex][0] = 'Error';
          statusNotes[entry.rowIndex][0] = appendNoteLine_(
            statusNotes[entry.rowIndex][0],
            `Error: ${result && result.message ? result.message : 'Unknown send failure'}`
          );
        }
        markDirtyRow_(dirtyWindow, entry.rowIndex);
      });

      mergeExistingStatusWindow_(sheet, statusColIndex, statusValues, statusNotes, dirtyWindow);

      flushBufferedSheetUpdates_(
        sheet,
        statusColIndex,
        emailColIndex,
        statusValues,
        statusNotes,
        emailNotes,
        dirtyWindow
      );

      cache.put(
        CONFIG.KEYS.PROGRESS_CACHE,
        JSON.stringify({ current: sentCount, total: totalToSend, status: 'sending' }),
        600
      );

      burstEntries = [];
    };

    for (let i = loopStart; i < data.length; i++) {
      // ---- Timeout guard ----
      if (Date.now() - executionStart > timeoutThreshold) {
        flushBurst();

        // Save state and schedule continuation
        setProperty(CONFIG.KEYS.LAST_PROCESSED_ROW, String(i));
        setProperty(CONFIG.KEYS.BATCH_CONFIG, JSON.stringify(config));

        // Clean up before creating to avoid trigger quota exhaustion
        cleanupOrphanedTriggers(config.spreadsheetId || spreadsheet.getId());
        const trigger = ScriptApp.newTrigger('resumeBatchSend')
          .timeBased()
          .after(60 * 1000) // resume in ~1 minute
          .create();
        mapTriggerToSpreadsheet(trigger, config.spreadsheetId);

        cache.put(
          CONFIG.KEYS.PROGRESS_CACHE,
          JSON.stringify({ current: sentCount, total: totalToSend, status: 'paused' }),
          7200
        );

        return {
          success: true,
          message: `Sent ${sentCount} emails so far. Batch will resume automatically in ~1 minute (timeout management).`,
          sentCount: sentCount,
          total: totalToSend,
          status: 'paused'
        };
      }

      if (hiddenRows[i]) continue;

      const row = data[i];

      // Skip completely empty rows
      if (row.every((cell) => !cell || String(cell).trim() === '')) {
        continue;
      }

      const status = statusValues[i][0];
      const email = String(row[emailColIndex]).trim();

      // Skip previously sent or missing email
      if (!email || (status && status !== '')) {
        continue;
      }

      // Basic email syntax validation
      if (!EMAIL_REGEX.test(email)) {
        statusValues[i][0] = 'Invalid Email';
        markDirtyRow_(dirtyWindow, i);
        continue;
      }

      // Process variables
      const subject = replaceVariables(subjectTemplate, headers, row);
      let htmlBody = replaceVariables(htmlTemplate, headers, row);
      const plainBody = replaceVariables(plainTemplate, headers, row);

      let cc = ccColIndex !== -1 && row[ccColIndex] ? String(row[ccColIndex]).trim() : '';
      if (!cc) cc = replaceVariables(ccTemplate, headers, row);

      let bcc = bccColIndex !== -1 && row[bccColIndex] ? String(row[bccColIndex]).trim() : '';
      if (!bcc) bcc = replaceVariables(bccTemplate, headers, row);

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
      emailNotes[i][0] = 'Tracking ID: ' + trackingId;
      markDirtyRow_(dirtyWindow, i);

      // Append tracking pixel if central tracking is configured
      if (CONFIG.TRACKING.CENTRAL_URL && CONFIG.TRACKING.SECRET_KEY) {
        const sheetId = config.spreadsheetId || spreadsheet.getId();
        const sheetName = encodeURIComponent(config.sheetName || sheet.getName());
        const rowNum = i + 2;
        const cell = `${statusColumnLetters}${rowNum}`;
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

      burstEntries.push({
        rowIndex: i,
        raw: raw
      });

      if (
        burstEntries.length >= SEND_BURST_SIZE ||
        Date.now() - executionStart > timeoutThreshold - BURST_TIMEOUT_BUFFER_MS
      ) {
        flushBurst();
        if (Date.now() - executionStart > timeoutThreshold && i < data.length - 1) {
          setProperty(CONFIG.KEYS.LAST_PROCESSED_ROW, String(i + 1));
          setProperty(CONFIG.KEYS.BATCH_CONFIG, JSON.stringify(config));

          cleanupOrphanedTriggers(config.spreadsheetId || spreadsheet.getId());
          const trigger = ScriptApp.newTrigger('resumeBatchSend')
            .timeBased()
            .after(60 * 1000)
            .create();
          mapTriggerToSpreadsheet(trigger, config.spreadsheetId);

          cache.put(
            CONFIG.KEYS.PROGRESS_CACHE,
            JSON.stringify({ current: sentCount, total: totalToSend, status: 'paused' }),
            7200
          );

          return {
            success: true,
            message: `Sent ${sentCount} emails so far. Batch will resume automatically in ~1 minute (timeout management).`,
            sentCount: sentCount,
            total: totalToSend,
            status: 'paused'
          };
        }
      }
    }

    flushBurst();

    // Clean up resumption state on completion
    PropertiesService.getUserProperties().deleteProperty(
      _getCompositeKey(CONFIG.KEYS.LAST_PROCESSED_ROW, config.spreadsheetId || spreadsheet.getId())
    );
    PropertiesService.getUserProperties().deleteProperty(
      _getCompositeKey(CONFIG.KEYS.BATCH_CONFIG, config.spreadsheetId || spreadsheet.getId())
    );

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
 * @param {Object} e Trigger event object
 */
function resumeBatchSend(e) {
  try {
    const spreadsheetId = getSpreadsheetIdFromTrigger(e);
    if (e && e.triggerUid) deleteTriggerMapping(e.triggerUid);

    // Delete the trigger that called us so it doesn't re-fire
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('resumeBatchSend', spreadsheetId);
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'resumeBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    // Retrieve saved state
    const lastRow = getProperty(CONFIG.KEYS.LAST_PROCESSED_ROW, spreadsheetId);
    const configJson = getProperty(CONFIG.KEYS.BATCH_CONFIG, spreadsheetId);

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
  const cache = CacheService.getUserCache();
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
    if (typeof cleanupOrphanedTriggers === 'function') cleanupOrphanedTriggers(config.spreadsheetId);

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
      deleteTriggerByHandler('runBackgroundBatchSend', config.spreadsheetId);
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'runBackgroundBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    // Guard against trigger quota exhaustion (limit: 20 per user per script)
    if (ScriptApp.getProjectTriggers().length >= 18) {
      cleanupOrphanedTriggers(config.spreadsheetId);
      if (ScriptApp.getProjectTriggers().length >= 18) {
        return {
          success: false,
          message:
            'Too many background tasks are already queued. Please wait a few minutes for the current batch to finish, then try again.'
        };
      }
    }

    // Create the trigger to fire almost immediately (1 millisecond)
    const trigger = ScriptApp.newTrigger('runBackgroundBatchSend').timeBased().after(1).create();
    mapTriggerToSpreadsheet(trigger, config.spreadsheetId);

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
 * @param {Object} e Trigger event object
 */
function runBackgroundBatchSend(e) {
  try {
    const spreadsheetId = getSpreadsheetIdFromTrigger(e);
    if (e && e.triggerUid) deleteTriggerMapping(e.triggerUid);

    // Delete the trigger that called us
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('runBackgroundBatchSend', spreadsheetId);
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'runBackgroundBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    // Retrieve saved configuration
    const configJson = getProperty(CONFIG.KEYS.BATCH_CONFIG, spreadsheetId);
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
    if (typeof cleanupOrphanedTriggers === 'function') cleanupOrphanedTriggers(config.spreadsheetId);

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
      deleteTriggerByHandler('startScheduledBatchSend', config.spreadsheetId);
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

    // Guard against trigger quota exhaustion (limit: 20 per user per script)
    if (ScriptApp.getProjectTriggers().length >= 18) {
      cleanupOrphanedTriggers(config.spreadsheetId);
      if (ScriptApp.getProjectTriggers().length >= 18) {
        return {
          success: false,
          message:
            'Too many background tasks are already queued. Please wait a few minutes for the current batch to finish, then try again.'
        };
      }
    }

    // Create the trigger
    const trigger = ScriptApp.newTrigger('startScheduledBatchSend').timeBased().at(new Date(scheduleTime)).create();
    mapTriggerToSpreadsheet(trigger, config.spreadsheetId);

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
function startScheduledBatchSend(e) {
  try {
    const spreadsheetId = getSpreadsheetIdFromTrigger(e);
    if (e && e.triggerUid) deleteTriggerMapping(e.triggerUid);

    // Delete the trigger that called us
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('startScheduledBatchSend', spreadsheetId);
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'startScheduledBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    // Retrieve saved configuration
    const configJson = getProperty(CONFIG.KEYS.SCHEDULED_BATCH_CONFIG, spreadsheetId);
    if (!configJson) {
      console.log('startScheduledBatchSend: No scheduled config found.');
      return;
    }

    const config = JSON.parse(configJson);
    PropertiesService.getUserProperties().deleteProperty(
      _getCompositeKey(CONFIG.KEYS.SCHEDULED_BATCH_CONFIG, spreadsheetId)
    );

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
