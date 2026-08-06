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
 * Pre-calculates hidden/filtered rows once using Sheets API so it completes in milliseconds.
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {number} rowCount Number of data rows starting at sheet row 2
 * @returns {Array<boolean>} 0-based array aligned to the data rows
 */
function buildHiddenRowMap_(spreadsheetId, sheetName, rowCount) {
  const hiddenRows = new Array(rowCount).fill(false);
  try {
    const sheetData = Sheets.Spreadsheets.get(spreadsheetId, {
      ranges: [sheetName],
      fields: 'sheets/data/rowMetadata(hiddenByFilter,hiddenByUser)'
    });

    const rowMetadata = sheetData.sheets?.[0]?.data?.[0]?.rowMetadata;
    if (rowMetadata && rowMetadata.length > 1) {
      // Offset by 1 for the headers row (rowMetadata[0] is headers, rowMetadata[1] is row 2)
      for (let i = 0; i < rowCount; i++) {
        const meta = rowMetadata[i + 1];
        if (meta && (meta.hiddenByFilter || meta.hiddenByUser)) {
          hiddenRows[i] = true;
        }
      }
    }
  } catch (e) {
    console.warn('Failed to fetch sheet metadata via Sheets API, falling back to all visible: ', e);
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
    const requests = pending.map((item) => buildGmailSendRequest_(oauthToken, item.entry.raw));
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
 * Helper to extract link URL from a RichTextValue object.
 * Handles both main text links and run-level links (Smart Chips, Hyperlinks).
 * @param {GoogleAppsScript.Spreadsheet.RichTextValue|null} richText
 * @returns {string|null}
 */
function extractLinkUrl_(richText) {
  if (!richText) return null;
  const mainUrl = richText.getLinkUrl();
  if (mainUrl) return mainUrl;
  const runs = richText.getRuns();
  if (runs) {
    for (let i = 0; i < runs.length; i++) {
      const runUrl = runs[i].getLinkUrl();
      if (runUrl) return runUrl;
    }
  }
  return null;
}

/**
 * Utility function to unescape common HTML entities and strip HTML tags from a string.
 * @param {string} str
 * @returns {string}
 */
function cleanVariableName_(str) {
  if (!str) return '';
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes double curly braces split by HTML tags in Gmail rich text content.
 * e.g. {<span>{</span>Var}<span>}</span> -> {{Var}}
 * @param {string} str
 * @returns {string}
 */
function normalizeBraces_(str) {
  if (!str) return '';
  return str
    .replace(/<span[^>]*>\s*\{\s*<\/span>/gi, '{')
    .replace(/<span[^>]*>\s*\}\s*<\/span>/gi, '}')
    .replace(/\{\s*<[^>]*>\s*\{/g, '{{')
    .replace(/\}\s*<[^>]*>\s*\}/g, '}}');
}

/**
 * Replaces {{variables}} in a string with data from a row.
 * Supports HTML draft formatting (bold/highlight/spans inside or surrounding braces),
 * HTML entities (&nbsp;), and smart chips/hyperlink pills via richTextRowData.
 * @param {string} template The text containing {{vars}}
 * @param {Array<string>} headers The array of column headers
 * @param {Array<any>} rowData The array of row display values
 * @param {Array<any>} [richTextRowData] Optional array of RichTextValue objects
 * @returns {string} The processed string
 */
function replaceVariables(template, headers, rowData, richTextRowData = null) {
  if (!template) return '';

  const normalizedTemplate = normalizeBraces_(template);

  // Pre-index headers (trimmed & lowercased) to row data values & link URLs
  const dataMap = {};
  const urlMap = {};

  headers.forEach((header, index) => {
    const key = String(header).trim().toLowerCase();
    const displayVal =
      rowData && rowData[index] !== undefined && rowData[index] !== null
        ? String(rowData[index])
        : '';
    dataMap[key] = displayVal;

    let linkUrl = null;
    if (richTextRowData && richTextRowData[index]) {
      linkUrl = extractLinkUrl_(richTextRowData[index]);
    }
    if (linkUrl) {
      urlMap[key] = linkUrl;
    }
  });

  // Regex matching {{ ... }} placeholders
  const regex = /\{\{\s*([\s\S]*?)\s*\}\}/g;

  return normalizedTemplate.replace(regex, (fullMatch, innerContent, offset, fullString) => {
    const cleanVarName = cleanVariableName_(innerContent);
    const key = cleanVarName.toLowerCase();

    if (dataMap[key] === undefined) {
      return fullMatch; // Variable not in headers, keep unchanged
    }

    const value = dataMap[key];
    const linkUrl = urlMap[key];

    // Check context in template: is this variable inside an href="..." attribute?
    const prefix = fullString.substring(Math.max(0, offset - 10), offset);
    const isInsideHref = /href=["']?$/i.test(prefix);

    let replacement = value;

    if (isInsideHref && linkUrl) {
      replacement = linkUrl;
    } else if (linkUrl && linkUrl !== value) {
      // Smart Chip / Hyperlink Pill: if substituted into HTML text context and has a link URL,
      // and display value is not already the URL:
      const isHtmlText = /<[a-z][\s\S]*>/i.test(template);
      if (isHtmlText && !isInsideHref) {
        const textLabel = value || linkUrl;
        replacement = `<a href="${linkUrl.replace(/&/g, '&amp;')}">${textLabel}</a>`;
      } else if (!isInsideHref) {
        replacement = linkUrl;
      }
    }

    // Preserve inner HTML tags/styling inside {{ ... }} if present (e.g. {{<b>Name</b>}} or {{<span style="...">Name</span>}})
    if (/<[^>]*>/.test(innerContent)) {
      const cleanRegex = new RegExp(cleanVarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      if (cleanRegex.test(innerContent)) {
        return innerContent.replace(cleanRegex, replacement);
      }
    }

    return replacement;
  });
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
    const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
    const headers = headerRange.getDisplayValues()[0].map((h) => String(h).trim());

    if (sheet.getLastRow() < 2) {
      throw new Error('No data found in Row 2 to test with.');
    }

    const testRowRange = sheet.getRange(2, 1, 1, sheet.getLastColumn());
    const testRow = testRowRange.getDisplayValues()[0];
    const testRowRichText = testRowRange.getRichTextValues()[0];
    const draft = GmailApp.getDraft(config.draftId);
    if (!draft) throw new Error('Draft not found.');

    const msg = draft.getMessage();

    // Process templates
    const subject = replaceVariables(msg.getSubject(), headers, testRow, testRowRichText);
    const htmlBody = replaceVariables(msg.getBody(), headers, testRow, testRowRichText);
    const plainBody = replaceVariables(msg.getPlainBody(), headers, testRow, testRowRichText);

    // The recipient is the active user for tests
    const recipient = Session.getActiveUser().getEmail();
    const senderEmail = config.senderAlias || recipient;

    // Extract inline image Content-IDs from the draft
    const inlineContentIds = getInlineContentIds_(msg.getId());
    const attachments = msg.getAttachments({ includeInlineImages: true });

    // Build MIME message with custom tracking headers (test emails have no CC/BCC)
    const raw = buildMimeMessage({
      to: recipient,
      from: senderEmail,
      senderName: config.senderName || '',
      replyTo: config.replyTo || '',
      subject: subject,
      plainBody: plainBody,
      htmlBody: htmlBody,
      cc: '',
      bcc: '',
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
  let lock = null;
  try {
    if ((!startRow || startRow === 0) && typeof cleanupOrphanedTriggers === 'function') {
      cleanupOrphanedTriggers(config.spreadsheetId, config.sheetName);
    }

    // Save state in case of UI reload (scoped to this spreadsheet + tab)
    const ssId = config.spreadsheetId;
    const tabName = config.sheetName;
    setPropertiesBatch(
      {
        [CONFIG.KEYS.SELECTED_DRAFT_ID]: config.draftId,
        [CONFIG.KEYS.SENDER_NAME]: config.senderName || '',
        [CONFIG.KEYS.SENDER_ALIAS]: config.senderAlias || '',
        [CONFIG.KEYS.REPLY_TO]: config.replyTo || '',
        [CONFIG.KEYS.EMAIL_COLUMN]: config.emailColumn
      },
      ssId,
      tabName
    );

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

    // Serialize sends against the same TAB so two users cannot both claim the same
    // unsent rows and double-send, while sends on other tabs/spreadsheets run
    // concurrently. Released in the finally block below.
    const lockSsId = config.spreadsheetId || spreadsheet.getId();
    const lockTab = config.sheetName || sheet.getName();
    lock = acquireSendLock_(lockSsId, lockTab);
    if (!lock) {
      if (isUiContext) {
        return {
          success: false,
          message: 'A send is already running for this tab — please wait a moment and refresh.'
        };
      }
      // Background/scheduled context: don't drop the batch. Persist resume state and
      // retry shortly so the remaining rows are not lost to lock contention.
      setProperty(CONFIG.KEYS.LAST_PROCESSED_ROW, String(startRow || 0), lockSsId, lockTab);
      setProperty(CONFIG.KEYS.BATCH_CONFIG, JSON.stringify(config), lockSsId, lockTab);
      cleanupOrphanedTriggers(lockSsId, lockTab);
      const retryTrigger = ScriptApp.newTrigger('resumeBatchSend').timeBased().after(1).create();
      mapTriggerToSpreadsheet(retryTrigger, lockSsId, lockTab);
      return {
        success: true,
        message: 'Another send is in progress for this tab; will retry shortly.',
        status: 'paused'
      };
    }

    // Pre-flight validation
    const validation = validateTemplate(config.draftId, sheet);
    if (!validation.isValid) {
      return {
        success: false,
        message: 'Validation failed. Missing columns: ' + validation.missingColumns.join(', ')
      };
    }

    const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
    const headers = headerRange.getDisplayValues()[0].map((h) => String(h).trim());

    // Determine which columns are email and merge status
    const emailColIndex = headers.indexOf(config.emailColumn);
    let statusColIndex = headers.findIndex((h) => String(h).toLowerCase() === 'merge status');

    const ccColIndex = headers.findIndex((h) => String(h).trim().toLowerCase() === 'cc');
    const bccColIndex = headers.findIndex((h) => String(h).trim().toLowerCase() === 'bcc');

    if (emailColIndex === -1) throw new Error('Email column not found.');
    if (statusColIndex === -1) {
      statusColIndex = headers.length;
      sheet
        .getRange(1, statusColIndex + 1)
        .setValue('Merge status')
        .setFontWeight('bold');
    }

    const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
    const data = dataRange.getDisplayValues();
    const richTextData = dataRange.getRichTextValues();
    const notes = dataRange.getNotes();
    const hiddenRows = buildHiddenRowMap_(lockSsId, lockTab, data.length);

    const statusValues = data.map((row) => [row[statusColIndex] || '']);
    const statusNotes = notes.map((row) => [row[statusColIndex] || '']);
    const emailNotes = notes.map((row) => [row[emailColIndex] || '']);
    const dirtyWindow = { start: null, end: null };

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
    const progressKey = CONFIG.KEYS.PROGRESS_CACHE + '_' + lockSsId;
    cache.put(
      progressKey,
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
      campaignId = getProperty(CONFIG.KEYS.CAMPAIGN_ID, lockSsId, lockTab);
      campaignLabelId = getProperty(CONFIG.KEYS.CAMPAIGN_LABEL_ID, lockSsId, lockTab);
    }
    if (!campaignId) {
      const currentSheetId = config.spreadsheetId || spreadsheet.getId();
      campaignId = generateCampaignId_(currentSheetId);
      setProperty(CONFIG.KEYS.CAMPAIGN_ID, campaignId, lockSsId, lockTab);
      setProperty(CONFIG.KEYS.CAMPAIGN_START_TIME, String(Date.now()), lockSsId, lockTab);

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
        setProperty(CONFIG.KEYS.CAMPAIGN_LABEL, labelName, lockSsId, lockTab);
        setProperty(CONFIG.KEYS.CAMPAIGN_LABEL_ID, campaignLabelId, lockSsId, lockTab);
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
        progressKey,
        JSON.stringify({ current: sentCount, total: totalToSend, status: 'sending' }),
        600
      );

      burstEntries = [];
    };

    for (let i = loopStart; i < data.length; i++) {
      // ---- Timeout guard ----
      if (Date.now() - executionStart > timeoutThreshold - BURST_TIMEOUT_BUFFER_MS) {
        flushBurst();

        // Save state and schedule continuation (scoped to this tab)
        setProperty(CONFIG.KEYS.LAST_PROCESSED_ROW, String(i), lockSsId, lockTab);
        setProperty(CONFIG.KEYS.BATCH_CONFIG, JSON.stringify(config), lockSsId, lockTab);

        // Clean up before creating to avoid trigger quota exhaustion
        cleanupOrphanedTriggers(lockSsId, lockTab);
        const trigger = ScriptApp.newTrigger('resumeBatchSend')
          .timeBased()
          .after(1) // resume as soon as Apps Script can schedule it
          .create();
        mapTriggerToSpreadsheet(trigger, lockSsId, lockTab);

        cache.put(
          progressKey,
          JSON.stringify({ current: sentCount, total: totalToSend, status: 'paused' }),
          7200
        );

        return {
          success: true,
          message: `Sent ${sentCount} emails so far. The rest is continuing in the background now.`,
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
      const rowRichText = richTextData[i];
      const subject = replaceVariables(subjectTemplate, headers, row, rowRichText);
      let htmlBody = replaceVariables(htmlTemplate, headers, row, rowRichText);
      const plainBody = replaceVariables(plainTemplate, headers, row, rowRichText);

      let cc = ccColIndex !== -1 && row[ccColIndex] ? String(row[ccColIndex]).trim() : '';
      if (!cc) cc = replaceVariables(ccTemplate, headers, row, rowRichText);

      let bcc = bccColIndex !== -1 && row[bccColIndex] ? String(row[bccColIndex]).trim() : '';
      if (!bcc) bcc = replaceVariables(bccTemplate, headers, row, rowRichText);

      const currentAttachments = attachments;

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

      if (burstEntries.length >= SEND_BURST_SIZE) {
        flushBurst();
      }
    }

    flushBurst();

    // Clean up resumption state on completion (scoped to this tab)
    PropertiesService.getUserProperties().deleteProperty(
      _getCompositeKey(CONFIG.KEYS.LAST_PROCESSED_ROW, lockSsId, lockTab)
    );
    PropertiesService.getUserProperties().deleteProperty(
      _getCompositeKey(CONFIG.KEYS.BATCH_CONFIG, lockSsId, lockTab)
    );

    // Update progress on completion
    cache.put(
      progressKey,
      JSON.stringify({ current: sentCount, total: totalToSend, status: 'complete' }),
      600
    );

    // Register this tab and (re)enable the per-spreadsheet background analytics scanner.
    setupAnalyticsTrigger(lockSsId, lockTab);

    // Run initial bounce check immediately to catch instant delivery failures
    if (typeof checkBounces === 'function') {
      try {
        checkBounces(Date.now(), lockSsId, lockTab);
      } catch (bounceErr) {
        console.error('Initial immediate bounce check failed: ', bounceErr);
      }
    }

    return {
      success: true,
      message: `Successfully sent ${sentCount} emails.`,
      sentCount: sentCount,
      total: totalToSend
    };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    if (lock) releaseSendLock_(lock);
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
    // Resolve and pin the originating spreadsheet + tab so state scoping matches the
    // tab that paused this batch.
    setTriggerSpreadsheetIdContext(e);
    const spreadsheetId = getSpreadsheetIdFromTrigger(e);
    const sheetName = getSheetNameFromTrigger(e);
    if (e && e.triggerUid) deleteTriggerMapping(e.triggerUid);

    // Delete the trigger that called us so it doesn't re-fire (this tab only)
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('resumeBatchSend', spreadsheetId, sheetName);
    } else {
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach((t) => {
        if (t.getHandlerFunction() === 'resumeBatchSend') {
          ScriptApp.deleteTrigger(t);
        }
      });
    }

    // Retrieve saved state (scoped to this tab)
    const lastRow = getProperty(CONFIG.KEYS.LAST_PROCESSED_ROW, spreadsheetId, sheetName);
    const configJson = getProperty(CONFIG.KEYS.BATCH_CONFIG, spreadsheetId, sheetName);

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
  let ssId = null;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) ssId = ss.getId();
  } catch (e) {
    // Ignore
  }
  const key = ssId ? CONFIG.KEYS.PROGRESS_CACHE + '_' + ssId : CONFIG.KEYS.PROGRESS_CACHE;
  let progressStr = cache.get(key);
  if (!progressStr && ssId) {
    // fallback to unscoped key just in case
    progressStr = cache.get(CONFIG.KEYS.PROGRESS_CACHE);
  }
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
    // Save the config so resumeBatchSend can pick it up if the UI times out (per tab)
    setProperty(
      CONFIG.KEYS.BATCH_CONFIG,
      JSON.stringify(config),
      config.spreadsheetId,
      config.sheetName
    );

    // Run immediately in UI context (25s timeout guard inside sendBatchEmails
    // will schedule a resumption trigger if the batch is too large)
    const result = sendBatchEmails(config, 0, true);
    return result;
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Schedules a batch send for a future date/time.
 * @param {Object} config The settings from the UI
 * @param {number} scheduleEpochMs Epoch time in milliseconds when the campaign should start
 * @returns {Object} {success: boolean, message: string}
 */
function scheduleBatchEmails(config, scheduleEpochMs) {
  try {
    const spreadsheetId = config.spreadsheetId;
    const sheetName = config.sheetName;

    // Save the config so the trigger handler can fetch it
    setProperty(CONFIG.KEYS.BATCH_CONFIG, JSON.stringify(config), spreadsheetId, sheetName);

    // Save the scheduled time
    setProperty(CONFIG.KEYS.SCHEDULED_TIME, String(scheduleEpochMs), spreadsheetId, sheetName);

    // Clean up any existing triggers for this tab to avoid collisions/duplicate schedules
    if (typeof cleanupOrphanedTriggers === 'function') {
      cleanupOrphanedTriggers(spreadsheetId, sheetName);
    }

    // Create the one-time trigger at the scheduled time
    const scheduledDate = new Date(scheduleEpochMs);
    const trigger = ScriptApp.newTrigger('startScheduledBatchSend')
      .timeBased()
      .at(scheduledDate)
      .create();

    // Map trigger to spreadsheet/tab context so getSpreadsheetIdFromTrigger can resolve it
    if (typeof mapTriggerToSpreadsheet === 'function') {
      mapTriggerToSpreadsheet(trigger, spreadsheetId, sheetName);
    }

    // Format local time for the response message
    const tz =
      config.userTimezone ||
      (typeof getSpreadsheetTimezoneSafe === 'function' ? getSpreadsheetTimezoneSafe() : 'GMT');
    const formattedDate = Utilities.formatDate(scheduledDate, tz, 'yyyy-MM-dd HH:mm z');

    return {
      success: true,
      message: `Campaign scheduled successfully for ${formattedDate}!`
    };
  } catch (err) {
    if (typeof ErrorLib !== 'undefined') {
      ErrorLib.logError(err, 'scheduleBatchEmails');
    }
    return { success: false, message: 'Scheduling failed: ' + err.message };
  }
}

/**
 * Trigger handler called when the scheduled campaign time is reached.
 * Resolves context, cleans up itself, and starts the batch send.
 * @param {Object} e Trigger event object
 */
function startScheduledBatchSend(e) {
  try {
    // Resolve and pin spreadsheet context from the trigger mapping
    if (typeof setTriggerSpreadsheetIdContext === 'function') {
      setTriggerSpreadsheetIdContext(e);
    }
    const spreadsheetId =
      typeof getSpreadsheetIdFromTrigger === 'function' ? getSpreadsheetIdFromTrigger(e) : null;
    const sheetName =
      typeof getSheetNameFromTrigger === 'function' ? getSheetNameFromTrigger(e) : null;

    // Clean up trigger mapping and the trigger itself
    if (e && e.triggerUid && typeof deleteTriggerMapping === 'function') {
      deleteTriggerMapping(e.triggerUid);
    }
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('startScheduledBatchSend', spreadsheetId, sheetName);
    }

    // Clear the scheduled time flag so the UI knows we are no longer in scheduled state
    if (typeof deleteProperty === 'function') {
      deleteProperty(CONFIG.KEYS.SCHEDULED_TIME, spreadsheetId, sheetName);
    }

    const configJson = getProperty(CONFIG.KEYS.BATCH_CONFIG, spreadsheetId, sheetName);
    if (!configJson) {
      console.log('startScheduledBatchSend: No saved config found.');
      return;
    }

    const config = JSON.parse(configJson);

    // Call sendBatchEmails(config, 0, false) (with isUiContext = false)
    console.log('startScheduledBatchSend: Starting scheduled batch send.');
    const result = sendBatchEmails(config, 0, false);
    console.log('startScheduledBatchSend completed with result: ' + JSON.stringify(result));
  } catch (err) {
    if (typeof ErrorLib !== 'undefined') {
      ErrorLib.logError(err, 'startScheduledBatchSend');
    }
    console.error('startScheduledBatchSend crashed: ', err);
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    replaceVariables,
    sendBatchEmails,
    sendTestEmail,
    startBackgroundBatchEmails,
    scheduleBatchEmails,
    startScheduledBatchSend
  };
}
