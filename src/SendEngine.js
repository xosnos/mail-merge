/**
 * Core engine for sending emails via GmailApp
 */

/**
 * Replaces {{variables}} in a string with data from a row
 * @param {string} template The text containing {{vars}}
 * @param {Array<string>} headers The array of column headers
 * @param {Array<any>} rowData The array of row data
 * @returns {string} The processed string
 */
function replaceVariables(template, headers, rowData) {
  if (!template) return '';
  let result = template;
  headers.forEach((header, index) => {
    // Escape regex characters in header
    const escapedHeader = header.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`\\{\\{\\s*${escapedHeader}\\s*\\}\\}`, 'gi');
    
    // Replace newline characters and get string value
    const replacement = rowData[index] !== undefined && rowData[index] !== null ? String(rowData[index]) : '';
    result = result.replace(regex, replacement);
  });
  return result;
}

/**
 * Sends a test email to the currently logged in user using Row 2 data.
 * @param {Object} config The settings from the UI
 * @returns {Object} {success: boolean, message: string}
 */
function sendTestEmail(config) {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    // Assuming data starts on row 2
    if (sheet.getLastRow() < 2) {
      throw new Error("No data found in Row 2 to test with.");
    }
    
    const testRow = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
    const draft = GmailApp.getDraft(config.draftId);
    if (!draft) throw new Error("Draft not found.");
    
    const msg = draft.getMessage();
    
    // Process templates
    const subject = replaceVariables(msg.getSubject(), headers, testRow);
    const htmlBody = replaceVariables(msg.getBody(), headers, testRow);
    const plainBody = replaceVariables(msg.getPlainBody(), headers, testRow);
    
    // The recipient is the active user for tests
    const recipient = Session.getActiveUser().getEmail();
    
    // Options
    const options = {
      htmlBody: htmlBody,
      attachments: msg.getAttachments(),
      name: config.senderName || '',
    };
    
    if (config.senderAlias) options.from = config.senderAlias;
    if (config.replyTo) options.replyTo = config.replyTo;
    
    // Send
    GmailApp.sendEmail(recipient, subject, plainBody, options);
    
    return { success: true, message: "Test email successfully sent to " + recipient };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Sends the batch of emails based on spreadsheet data.
 * @param {Object} config The settings from the UI
 * @returns {Object} {success: boolean, message: string}
 */
function sendBatchEmails(config) {
  try {
    // Save state in case of UI reload
    setProperty(CONFIG.KEYS.SELECTED_DRAFT_ID, config.draftId);
    setProperty(CONFIG.KEYS.SENDER_NAME, config.senderName);
    setProperty(CONFIG.KEYS.SENDER_ALIAS, config.senderAlias);
    setProperty(CONFIG.KEYS.REPLY_TO, config.replyTo);
    setProperty(CONFIG.KEYS.EMAIL_COLUMN, config.emailColumn);
    
    // Check quota
    const quota = MailApp.getRemainingDailyQuota();
    if (quota < 1) {
      throw new Error("You have reached your daily Google email quota limit.");
    }
    
    const sheet = SpreadsheetApp.getActiveSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error("No data available to send.");
    
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    
    // Determine which columns are email and merge status
    const emailColIndex = headers.indexOf(config.emailColumn);
    let statusColIndex = headers.findIndex(h => String(h).toLowerCase() === 'merge status');
    
    if (emailColIndex === -1) throw new Error("Email column not found.");
    if (statusColIndex === -1) {
      // Create status col if missing during batch
      statusColIndex = headers.length;
      sheet.getRange(1, statusColIndex + 1).setValue("Merge status").setFontWeight("bold");
    }
    
    const draft = GmailApp.getDraft(config.draftId);
    if (!draft) throw new Error("Draft not found.");
    const msg = draft.getMessage();
    const attachments = msg.getAttachments();
    
    const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
    const data = dataRange.getValues();
    
    let sentCount = 0;
    
    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const status = row[statusColIndex];
        const email = String(row[emailColIndex]).trim();
        
        // Skip previously sent or missing email
        if (!email || (status && status !== '')) {
            continue;
        }
        
        // Basic email syntax validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            sheet.getRange(i + 2, statusColIndex + 1).setValue("Invalid Email");
            continue;
        }
        
        // Skip if out of quota
        if (MailApp.getRemainingDailyQuota() < 1) {
             return { success: false, message: `Sent ${sentCount} emails but ran out of quota.` };
        }
        
        // Process variables
        const subject = replaceVariables(msg.getSubject(), headers, row);
        const htmlBody = replaceVariables(msg.getBody(), headers, row);
        const plainBody = replaceVariables(msg.getPlainBody(), headers, row);
        
        const options = {
          htmlBody: htmlBody,
          attachments: attachments,
          name: config.senderName || '',
        };
        
        if (config.senderAlias) options.from = config.senderAlias;
        if (config.replyTo) options.replyTo = config.replyTo;
        
        try {
           GmailApp.sendEmail(email, subject, plainBody, options);
           sheet.getRange(i + 2, statusColIndex + 1).setValue("Sent");
           sentCount++;
        } catch(e) {
           sheet.getRange(i + 2, statusColIndex + 1).setValue("Error: " + e.message);
        }
    }
    
    return { success: true, message: `Successfully sent ${sentCount} emails.` };
  } catch(err) {
    return { success: false, message: err.message };
  }
}
