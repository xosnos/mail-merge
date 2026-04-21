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
      return ContentService.createTextOutput('Missing params');
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
      return ContentService.createTextOutput('Invalid signature');
    }

    if (ts) {
      const OPEN_DELAY_THRESHOLD_MS = 10000; // 10 seconds
      if (Date.now() - parseInt(ts, 10) < OPEN_DELAY_THRESHOLD_MS) {
        // Ignore pre-fetch or immediate user view
        return ContentService.createTextOutput('OK');
      }
    }

    const service = getOAuthService(user);
    if (!service.hasAccess()) {
      console.log('No access. Error: ', service.getLastError());
      return ContentService.createTextOutput('OAuth Error');
    }

    const token = service.getAccessToken();
    const safeSheetName = sheetName.replace(/'/g, "''");

    let targetRange = `'${safeSheetName}'!${cell}`;
    if (tid) {
      let needsFullSearch = true;
      const rowMatch = cell.match(/\d+/);
      const expectedRow = rowMatch ? parseInt(rowMatch[0], 10) : null;

      if (expectedRow) {
        const fastSearchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?ranges=${encodeURIComponent("'" + safeSheetName + "'!1:1")}&ranges=${encodeURIComponent("'" + safeSheetName + "'!" + expectedRow + ':' + expectedRow)}&fields=sheets(data(rowData(values(note,formattedValue))))`;
        const fastRes = UrlFetchApp.fetch(fastSearchUrl, {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + token },
          muteHttpExceptions: true
        });

        if (fastRes.getResponseCode() === 200) {
          const fastData = JSON.parse(fastRes.getContentText());
          let statusCol = -1;
          let foundTid = false;

          if (fastData.sheets && fastData.sheets[0] && fastData.sheets[0].data) {
            const rangesData = fastData.sheets[0].data;

            // Process row 1 for 'merge status' column
            if (rangesData[0] && rangesData[0].rowData && rangesData[0].rowData[0]) {
              const headerValues = rangesData[0].rowData[0].values;
              if (headerValues) {
                for (let c = 0; c < headerValues.length; c++) {
                  if (
                    headerValues[c] &&
                    headerValues[c].formattedValue &&
                    headerValues[c].formattedValue.toLowerCase() === 'merge status'
                  ) {
                    statusCol = c;
                    break;
                  }
                }
              }
            }

            // Process expectedRow for tid note
            if (rangesData[1] && rangesData[1].rowData && rangesData[1].rowData[0]) {
              const rowValues = rangesData[1].rowData[0].values;
              if (rowValues) {
                for (let c = 0; c < rowValues.length; c++) {
                  if (rowValues[c] && rowValues[c].note && rowValues[c].note.includes(tid)) {
                    foundTid = true;
                    break;
                  }
                }
              }
            }
          }

          if (foundTid && statusCol !== -1) {
            needsFullSearch = false;
            let temp = statusCol;
            let letter = '';
            while (temp >= 0) {
              letter = String.fromCharCode(65 + (temp % 26)) + letter;
              temp = Math.floor(temp / 26) - 1;
            }
            targetRange = `'${safeSheetName}'!${letter}${expectedRow}`;
          }
        }
      }

      if (needsFullSearch) {
        const searchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?ranges=${encodeURIComponent("'" + safeSheetName + "'")}&fields=sheets(data(rowData(values(note,formattedValue))))`;
        const searchRes = UrlFetchApp.fetch(searchUrl, {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + token },
          muteHttpExceptions: true
        });

        if (searchRes.getResponseCode() === 200) {
          const searchData = JSON.parse(searchRes.getContentText());
          if (
            searchData.sheets &&
            searchData.sheets[0] &&
            searchData.sheets[0].data &&
            searchData.sheets[0].data[0] &&
            searchData.sheets[0].data[0].rowData
          ) {
            const rowData = searchData.sheets[0].data[0].rowData;
            let foundRow = -1;
            let statusCol = -1;

            for (let r = 0; r < rowData.length; r++) {
              const rowValues = rowData[r].values;
              if (!rowValues) continue;

              for (let c = 0; c < rowValues.length; c++) {
                const cellData = rowValues[c];
                if (!cellData) continue;

                if (
                  r === 0 &&
                  cellData.formattedValue &&
                  cellData.formattedValue.toLowerCase() === 'merge status'
                ) {
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
    }

    const cellUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?ranges=${encodeURIComponent(targetRange)}&fields=sheets(properties(sheetId),data(rowData(values(note,formattedValue))))`;

    // 1. Get current cell value, note, and tabId
    const getRes = UrlFetchApp.fetch(cellUrl, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });

    if (getRes.getResponseCode() !== 200) {
      console.log('GET Error:', getRes.getContentText());
      return ContentService.createTextOutput('API Error');
    }

    const data = JSON.parse(getRes.getContentText());
    if (!data.sheets || !data.sheets[0]) return ContentService.createTextOutput('OK');

    const tabId = data.sheets[0].properties.sheetId;
    let existingVal = '';
    let existingNote = '';

    if (
      data.sheets[0].data &&
      data.sheets[0].data[0] &&
      data.sheets[0].data[0].rowData &&
      data.sheets[0].data[0].rowData[0] &&
      data.sheets[0].data[0].rowData[0].values
    ) {
      const cellData = data.sheets[0].data[0].rowData[0].values[0];
      if (cellData) {
        existingVal = cellData.formattedValue || '';
        existingNote = cellData.note || '';
      }
    }

    const lower = existingVal.trim().toLowerCase();
    if (lower.includes('sent') || lower.includes('opened')) {
      // Use script timezone
      const timeZone = Session.getScriptTimeZone();
      const timeString = Utilities.formatDate(new Date(), timeZone, 'MM/dd HH:mm z');
      const newVal = 'Email opened';
      const newNote = existingNote
        ? existingNote + '\nOpened: ' + timeString
        : 'Opened: ' + timeString;

      const a1Match = targetRange.match(/!([A-Z]+)(\d+)$/);
      if (a1Match) {
        const colStr = a1Match[1];
        const rowStr = a1Match[2];
        const rowIdx = parseInt(rowStr, 10) - 1;
        let colIdx = 0;
        for (let i = 0; i < colStr.length; i++) {
          colIdx = colIdx * 26 + (colStr.charCodeAt(i) - 64);
        }
        colIdx = colIdx - 1;

        const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
        const putRes = UrlFetchApp.fetch(batchUrl, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          payload: JSON.stringify({
            requests: [
              {
                updateCells: {
                  range: {
                    sheetId: tabId,
                    startRowIndex: rowIdx,
                    endRowIndex: rowIdx + 1,
                    startColumnIndex: colIdx,
                    endColumnIndex: colIdx + 1
                  },
                  rows: [
                    {
                      values: [
                        {
                          userEnteredValue: { stringValue: newVal },
                          note: newNote
                        }
                      ]
                    }
                  ],
                  fields: 'userEnteredValue,note'
                }
              }
            ]
          }),
          muteHttpExceptions: true
        });
        console.log('PUT Response:', putRes.getContentText());
      }
    }
  } catch (err) {
    console.log('Error:', err.message);
  }

  // A webhook pixel ping can return an empty response
  return ContentService.createTextOutput('OK');
}
