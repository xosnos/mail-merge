function getScriptProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function getOAuthService(userEmail) {
    const privateKey = (getScriptProp('SERVICE_ACCOUNT_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
    return OAuth2.createService('SheetsDWD_' + userEmail)
      .setTokenUrl('https://oauth2.googleapis.com/token')
      .setPrivateKey(privateKey)
      .setIssuer(getScriptProp('SERVICE_ACCOUNT_CLIENT_EMAIL'))
      .setSubject(userEmail)
      .setPropertyStore(PropertiesService.getScriptProperties())
      .setScope('https://www.googleapis.com/auth/spreadsheets');
}

function doGet(e) {
  try {
    const { sheetId, sheetName, cell, user, ts, tid, sig } = e.parameter;
    if (!sheetId || !sheetName || !cell || !user || !sig) {
      return ContentService.createTextOutput("Missing params");
    }

    const secretKey = getScriptProp('SECRET_KEY');
    const payloadObj = { sheetId, sheetName, cell, user };
    if (ts) {
      payloadObj.ts = parseInt(ts, 10);
    }
    if (tid) {
      payloadObj.tid = tid;
    }
    const payload = JSON.stringify(payloadObj);
    const expectedSig = Utilities.base64EncodeWebSafe(
      Utilities.computeHmacSha256Signature(payload, secretKey)
    );

    if (sig !== expectedSig) {
      return ContentService.createTextOutput("Invalid signature");
    }

    if (ts) {
      const OPEN_DELAY_THRESHOLD_MS = 10000; // 10 seconds
      if (Date.now() - parseInt(ts, 10) < OPEN_DELAY_THRESHOLD_MS) {
        // Ignore pre-fetch or immediate user view
        return ContentService.createTextOutput("OK");
      }
    }

    const service = getOAuthService(user);
    if (!service.hasAccess()) {
      console.log('No access. Error: ', service.getLastError());
      return ContentService.createTextOutput("OAuth Error");
    }

    const token = service.getAccessToken();
    const safeSheetName = sheetName.replace(/'/g, "''");
    
    let targetRange = `'${safeSheetName}'!${cell}`;
    if (tid) {
      const searchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?ranges=${encodeURIComponent("'" + safeSheetName + "'")}&fields=sheets(data(rowData(values(note,formattedValue))))`;
      const searchRes = UrlFetchApp.fetch(searchUrl, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      });
      
      if (searchRes.getResponseCode() === 200) {
        const searchData = JSON.parse(searchRes.getContentText());
        if (searchData.sheets && searchData.sheets[0] && searchData.sheets[0].data && searchData.sheets[0].data[0] && searchData.sheets[0].data[0].rowData) {
          const rowData = searchData.sheets[0].data[0].rowData;
          let foundRow = -1;
          let statusCol = -1;
          
          for (let r = 0; r < rowData.length; r++) {
            const rowValues = rowData[r].values;
            if (!rowValues) continue;
            
            for (let c = 0; c < rowValues.length; c++) {
              const cellData = rowValues[c];
              if (!cellData) continue;
              
              if (r === 0 && cellData.formattedValue && cellData.formattedValue.toLowerCase() === 'merge status') {
                statusCol = c;
              }
              
              if (cellData.note && cellData.note.includes(tid)) {
                foundRow = r;
              }
            }
          }
          
          if (foundRow !== -1 && statusCol !== -1) {
            let temp = statusCol;
            let letter = '';
            while (temp >= 0) {
              letter = String.fromCharCode(65 + (temp % 26)) + letter;
              temp = Math.floor(temp / 26) - 1;
            }
            targetRange = `'${safeSheetName}'!${letter}${foundRow + 1}`;
          }
        }
      }
    }

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(targetRange)}`;

    // 1. Get current cell value
    const getRes = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });

    if (getRes.getResponseCode() !== 200) {
      console.log('GET Error:', getRes.getContentText());
      return ContentService.createTextOutput("API Error");
    }

    const data = JSON.parse(getRes.getContentText());
    const existingVal = (data.values && data.values[0] && data.values[0][0]) ? String(data.values[0][0]) : "";

    const lower = existingVal.toLowerCase();
    if (lower.startsWith('sent') || lower.includes('opened')) {
      // Use script timezone
      const timeZone = Session.getScriptTimeZone();
      const timeString = Utilities.formatDate(new Date(), timeZone, 'MM/dd HH:mm');
      const newVal = `Opened ${timeString}`;
      
      const putRes = UrlFetchApp.fetch(`${url}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify({
          values: [[newVal]]
        }),
        muteHttpExceptions: true
      });
      console.log('PUT Response:', putRes.getContentText());
    }
  } catch(err) {
    console.log("Error:", err.message);
  }

  // A webhook pixel ping can return an empty response
  return ContentService.createTextOutput("OK");
}
