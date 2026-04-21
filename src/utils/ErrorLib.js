/**
 * Central Error Logging Utility.
 * Writes background execution errors to an invisible '_Logs' sheet.
 */
var ErrorLib = {
  /**
   * Logs an error to the current active spreadsheet's _Logs tab.
   * If the tab doesn't exist, it creates and hides it.
   * @param {Error|string} error The error object or string message
   * @param {string} context Describe where the error occurred (e.g. 'resumeBatchSend')
   */
  logError: function (error, context = 'Unknown Context') {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return; // Cannot log if no active spreadsheet context

      let logSheet = ss.getSheetByName('_Logs');
      if (!logSheet) {
        logSheet = ss.insertSheet('_Logs');
        logSheet.hideSheet();
        logSheet.appendRow(['Timestamp', 'Context', 'Message', 'Stack Trace']);
        logSheet.getRange('A1:D1').setFontWeight('bold');
        logSheet.setFrozenRows(1);
      }

      const timestamp = new Date();
      const message = typeof error === 'string' ? error : error.message;
      const stack = error.stack || 'No stack trace';

      logSheet.appendRow([timestamp, context, message, stack]);
    } catch (e) {
      console.error('Failed to write to dead-letter log', e);
    }
  }
};

if (typeof module !== 'undefined') {
  module.exports = { ErrorLib };
}
