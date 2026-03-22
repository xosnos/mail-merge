/**
 * Backend Web App webhook to receive pixel tracking data.
 * The client loads <img src="URL?sheetId=...&row=5" />
 */
function doGet(e) {
  try {
    console.log("doGet hit with params:", JSON.stringify(e.parameter));
    if (!e.parameter.sheetId || !e.parameter.row) {
      console.log("Missing parameters.");
      return ContentService.createTextOutput("Missing parameters.");
    }

    const ss = SpreadsheetApp.openById(e.parameter.sheetId);
    if (!ss) {
      console.log("Sheet not found.");
      return ContentService.createTextOutput("Sheet not found.");
    }
    
    // Default to the first sheet, or use parameter if provided
    let sheet;
    if (e.parameter.sheetName) {
      sheet = ss.getSheetByName(e.parameter.sheetName);
    }
    if (!sheet) {
      sheet = ss.getSheets()[0];
    }
    
    const rowIndex = parseInt(e.parameter.row, 10);
    console.log(`Processing rowIndex: ${rowIndex} on sheet: ${sheet.getName()}`);
    
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const statusColIndex = headers.findIndex(h => String(h).toLowerCase() === 'merge status');
    
    if (statusColIndex !== -1 && rowIndex > 1) {
       const existingVal = String(sheet.getRange(rowIndex, statusColIndex + 1).getValue()).trim();
       console.log(`Existing value found: '${existingVal}'`);
       
       // Handle case-insensitivity just in case
       if (existingVal.toLowerCase() === 'sent' || existingVal.toLowerCase().includes('opened')) {
          const tz = ss.getSpreadsheetTimeZone() || "GMT";
          const timeString = Utilities.formatDate(new Date(), tz, "MM/dd HH:mm");
          sheet.getRange(rowIndex, statusColIndex + 1).setValue(`Opened ${timeString}`);
          console.log("Successfully updated cell to Opened");
       } else {
          console.log("Skipped updating because value wasn't 'Sent'");
       }
    } else {
       console.log("Merge status column missing or row invalid.");
    }
  } catch(err) {
    console.log("doGet Error: " + err.message);
  }
  return ContentService.createTextOutput("OK");
}

/**
 * Triggered from the UI. Scans Gmail for "mailer-daemon" bounces sent within the last day
 * that relate to emails found in the active sheet.
 */
function checkBounces() {
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { success: false, message: "No data in sheet." };

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const emailColIndex = headers.findIndex(h => String(h).toLowerCase().includes('email'));
    const statusColIndex = headers.findIndex(h => String(h).toLowerCase() === 'merge status');
    
    if (emailColIndex === -1) return { success: false, message: "No email column to match." };
    if (statusColIndex === -1) return { success: false, message: "No 'Merge status' column found." };

    // Get basic recent bounces
    const threads = GmailApp.search('from:mailer-daemon in:inbox newer_than:2d');
    let bounceDict = [];
    
    threads.forEach(thread => {
      const msgs = thread.getMessages();
      msgs.forEach(m => {
        const body = m.getPlainBody();
        // Regex to extract failed email
        const emailMatch = body.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g);
        if (emailMatch) {
            emailMatch.forEach(em => bounceDict.push(em.toLowerCase()));
        }
      });
    });

    if (bounceDict.length === 0) return { success: true, message: "No recent bounce notifications found in inbox." };
    
    const dataRange = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
    const data = dataRange.getValues();
    let bounceCount = 0;
    
    for (let i = 0; i < data.length; i++) {
        const email = String(data[i][emailColIndex]).trim().toLowerCase();
        const existingStatus = String(data[i][statusColIndex]).trim();
        
        if (email && bounceDict.includes(email) && existingStatus !== 'Bounced') {
            const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || "GMT";
            const timeString = Utilities.formatDate(new Date(), tz, "MM/dd HH:mm");
            sheet.getRange(i + 2, statusColIndex + 1).setValue(`Bounced ${timeString}`);
            bounceCount++;
        }
    }
    
    return { success: true, message: `Checked bounces. Marked ${bounceCount} rows as bounced.` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}
