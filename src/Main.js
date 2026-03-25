/**
 * Main application logic and helpers
 */

/**
 * Validates the selected draft's variables against the active sheet's headers.
 * @param {string} draftId 
 * @returns {Object} { isValid: boolean, missingColumns: string[], variables: string[] }
 */
function validateTemplate(draftId) {
  const sheet = SpreadsheetApp.getActiveSheet();
  
  // Handle empty sheet case
  if (sheet.getLastColumn() === 0) {
    return { isValid: false, missingColumns: ['Sheet is empty. Add headers to Row 1.'], variables: [] };
  }
  
  // Get headers from Row 1
  const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  const headers = headerRange.getValues()[0].map(h => String(h).trim());
  
  // Get variables from Draft
  const variables = getDraftVariables(draftId);
  
  // Normalize headers for case-insensitive and space-insensitive matching
  const normalizedHeaders = headers.map(h => String(h).toLowerCase().replace(/\s+/g, ''));
  
  // Find variables that don't match any header
  const missingColumns = variables.filter(variable => {
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
  } else if (lastCol > 0) {
    // Ensure "Merge status" column exists
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const hasStatus = headers.some(h => String(h).toLowerCase() === 'merge status');
    
    let nextCol = lastCol + 1;
    if (!hasStatus) sheet.getRange(1, nextCol++).setValue('Merge status').setFontWeight('bold');
  }
}
