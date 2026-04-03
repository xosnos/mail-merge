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
    const { sheetId, sheetName, cell, user, sig } = e.parameter;
    if (!sheetId || !sheetName || !cell || !user || !sig) {
      return ContentService.createTextOutput("Missing params");
    }

    const secretKey = getScriptProp('SECRET_KEY');
    const payload = JSON.stringify({ sheetId, sheetName, cell, user });
    const expectedSig = Utilities.base64EncodeWebSafe(
      Utilities.computeHmacSha256Signature(payload, secretKey)
    );

    if (sig !== expectedSig) {
      return ContentService.createTextOutput("Invalid signature");
    }

    const service = getOAuthService(user);
    if (!service.hasAccess()) {
      console.log('No access. Error: ', service.getLastError());
      return ContentService.createTextOutput("OAuth Error");
    }

    const token = service.getAccessToken();
    const safeSheetName = sheetName.replace(/'/g, "''");
    const range = `'${safeSheetName}'!${cell}`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;

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
