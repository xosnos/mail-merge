function testOAuth() {
  const service = getOAuthService('steven.nguyen1@unavsa.org');
  if (service.hasAccess()) {
    console.log('Has access!');
    const token = service.getAccessToken();
    console.log('Access token acquired. Length: ' + token.length);
  } else {
    console.log('No access! ' + service.getLastError());
  }
}
