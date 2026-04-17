import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module",
      globals: {
        PropertiesService: "readonly",
        SpreadsheetApp: "readonly",
        GmailApp: "readonly",
        MailApp: "readonly",
        ScriptApp: "readonly",
        UrlFetchApp: "readonly",
        ContentService: "readonly",
        CacheService: "readonly",
        CardService: "readonly",
        Session: "readonly",
        Utilities: "readonly",
        Logger: "readonly",
        OAuth2: "readonly",
        Gmail: "readonly",
        module: "readonly",
        require: "readonly",
        console: "readonly",
        Buffer: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn"
    }
  }
];