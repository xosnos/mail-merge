/**
 * Main application logic and helpers
 */

/**
 * Cleans up orphaned time-driven triggers for this project.
 * Limits the number of triggers for background functions to prevent hitting quota limits.
 */
function cleanupOrphanedTriggers() {
  try {
    const activeHandlers = ['startScheduledBatchSend', 'resumeBatchSend', 'runAnalyticsScanner'];
    const seen = {};

    // Clean up project triggers
    const projectTriggers = ScriptApp.getProjectTriggers();
    projectTriggers.forEach((t) => {
      const handler = t.getHandlerFunction();
      if (activeHandlers.includes(handler)) {
        if (seen[handler]) {
          ScriptApp.deleteTrigger(t);
        } else {
          seen[handler] = true;
        }
      } else if (t.getEventType() === ScriptApp.EventType.CLOCK) {
        ScriptApp.deleteTrigger(t);
      }
    });

    // Clean up document triggers (Add-on specific limits apply per document)
    try {
      const doc = SpreadsheetApp.getActiveSpreadsheet();
      if (doc) {
        const docTriggers = ScriptApp.getUserTriggers(doc);
        docTriggers.forEach((t) => {
          const handler = t.getHandlerFunction();
          if (activeHandlers.includes(handler)) {
            if (seen[handler]) {
              ScriptApp.deleteTrigger(t);
            } else {
              seen[handler] = true;
            }
          } else if (t.getEventType() === ScriptApp.EventType.CLOCK) {
            ScriptApp.deleteTrigger(t);
          }
        });
      }
    } catch (docErr) {
      console.error('Doc trigger cleanup ignored: ' + docErr);
    }
  } catch (err) {
    console.error('Failed to clean up triggers: ' + err);
  }
}

function deleteTriggerByHandler(handlerName) {
  try {
    const projectTriggers = ScriptApp.getProjectTriggers();
    projectTriggers.forEach((t) => {
      if (t.getHandlerFunction() === handlerName) {
        ScriptApp.deleteTrigger(t);
      }
    });

    try {
      const doc = SpreadsheetApp.getActiveSpreadsheet();
      if (doc) {
        const docTriggers = ScriptApp.getUserTriggers(doc);
        docTriggers.forEach((t) => {
          if (t.getHandlerFunction() === handlerName) {
            ScriptApp.deleteTrigger(t);
          }
        });
      }
    } catch (e) {
      // Ignore if not bound to doc
    }
  } catch (err) {
    console.error('Failed to delete trigger: ' + err);
  }
}

/**
 * Validates the selected draft's variables against the active sheet's headers.
 * @param {string} draftId
 * @returns {Object} { isValid: boolean, missingColumns: string[], variables: string[] }
 */
function validateTemplate(draftId) {
  const sheet = SpreadsheetApp.getActiveSheet();

  // Handle empty sheet case
  if (sheet.getLastColumn() === 0) {
    return {
      isValid: false,
      missingColumns: ['Sheet is empty. Add headers to Row 1.'],
      variables: []
    };
  }

  // Get headers from Row 1
  const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  const headers = headerRange.getValues()[0].map((h) => String(h).trim());

  // Get variables from Draft
  const variables = getDraftVariables(draftId);

  // Normalize headers for case-insensitive and space-insensitive matching
  const normalizedHeaders = headers.map((h) => String(h).toLowerCase().replace(/\s+/g, ''));

  // Find variables that don't match any header
  const missingColumns = variables.filter((variable) => {
    const normalizedVar = String(variable).toLowerCase().replace(/\s+/g, '');
    return !normalizedHeaders.includes(normalizedVar);
  });

  return {
    isValid: missingColumns.length === 0,
    missingColumns: missingColumns,
    variables: variables
  };
}

/**
 * Ensures the sheet is initialized. If empty, populates a template.
 * If not empty, ensures a "Merge status" column exists.
 */
function initializeSheet() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const lastCol = sheet.getLastColumn();

  if (lastCol === 0 && sheet.getLastRow() === 0) {
    const headers = ['Email Address', 'First Name', 'Last Name', 'Merge status'];

    const email = Session.getActiveUser().getEmail() || '';
    let firstName = 'Test';
    let lastName = 'User';

    // Parse domain email formats
    if (email && email.includes('@')) {
      // e.g. first.middleInitial.last123@...
      let alias = email.split('@')[0].replace(/[0-9]+$/, '');
      const parts = alias.split('.');

      if (parts.length >= 1 && parts[0]) {
        firstName = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
      }
      if (parts.length >= 2 && parts[parts.length - 1]) {
        const last = parts[parts.length - 1];
        lastName = last.charAt(0).toUpperCase() + last.slice(1).toLowerCase();
      }
    }

    const row2 = [email, firstName, lastName, ''];

    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.getRange(2, 1, 1, row2.length).setValues([row2]);
    sheet.autoResizeColumns(1, headers.length);
    applyConditionalFormatting_(sheet, headers.length);
  } else if (lastCol > 0) {
    // Ensure "Merge status" column exists
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const statusColIndex = headers.findIndex((h) => String(h).toLowerCase() === 'merge status');

    let nextCol = lastCol + 1;
    if (statusColIndex === -1) {
      sheet.getRange(1, nextCol).setValue('Merge status').setFontWeight('bold');
      applyConditionalFormatting_(sheet, nextCol);
    } else {
      applyConditionalFormatting_(sheet, statusColIndex + 1);
    }
  }
}

/**
 * Applies YAMM-style conditional formatting rules to the Merge status column.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} colIndex 1-based index of the Merge status column
 */
function applyConditionalFormatting_(sheet, colIndex) {
  const numRows = sheet.getMaxRows();
  if (numRows < 2) return;
  const range = sheet.getRange(2, colIndex, numRows - 1, 1);
  let rules = sheet.getConditionalFormatRules();

  // Create rule helper
  const createRule = (text, bgColor, fontColor) => {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(text)
      .setBackground(bgColor)
      .setFontColor(fontColor)
      .setRanges([range])
      .build();
  };

  // Check if we already have our rules to avoid stacking (check for 'Email opened' on this column)
  const hasRules = rules.some(rule => {
    const condition = rule.getBooleanCondition();
    if (!condition) return false;
    const ruleRanges = rule.getRanges();
    return condition.getCriteriaType() === SpreadsheetApp.BooleanCriteria.TEXT_EQUAL_TO &&
           condition.getCriteriaValues()[0] === 'Email opened' &&
           ruleRanges.some(r => r.getColumn() === colIndex);
  });

  if (!hasRules) {
    const newRules = [
      createRule('Email opened', '#d9ead3', '#274e13'), // Light green
      createRule('Email sent', '#d0e0e3', '#134f5c'), // Light blue
      createRule('Replied', '#d9d2e9', '#351c75'), // Light purple
      createRule('Bounced', '#f4cccc', '#990000'), // Light red
      createRule('Error', '#fce5cd', '#b45f06'), // Light orange
      createRule('Invalid Email', '#fce5cd', '#b45f06')
    ];
    rules.push(...newRules);
    sheet.setConditionalFormatRules(rules);
  }
}
