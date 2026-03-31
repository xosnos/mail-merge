function testOAuth() {
  UrlFetchApp.fetch("https://google.com");
  const service = getOAuthService('steven.nguyen1@unavsa.org');
  if (service.hasAccess()) {
    console.log("Has access!");
    console.log(service.getAccessToken());
  } else {
    console.log("No access! " + service.getLastError());
  }
}
