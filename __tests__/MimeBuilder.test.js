const { buildMimeMessage } = require('../src/utils/MimeBuilder');

// Mock Google Apps Script Utilities for testing MimeBuilder
global.Utilities = {
  getUuid: () => 'mock-uuid',
  base64Encode: (str) => Buffer.from(str).toString('base64'),
  base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  Charset: { UTF_8: 'UTF-8' },
  newBlob: (str) => ({ getBytes: () => Buffer.from(str) })
};

describe('MimeBuilder', () => {
  describe('buildMimeMessage', () => {
    it('should build a simple alternative MIME message without attachments', () => {
      const opts = {
        to: 'recipient@example.com',
        from: 'sender@example.com',
        senderName: 'Test Sender',
        subject: 'Test Subject',
        plainBody: 'Hello World',
        htmlBody: '<p>Hello World</p>',
        customHeaders: {
          'X-Campaign-ID': 'test_campaign'
        }
      };

      const result = buildMimeMessage(opts);
      expect(typeof result).toBe('string');
      
      // Decode result to check contents
      const decoded = Buffer.from(result, 'base64').toString('utf8');
      expect(decoded).toContain('To: recipient@example.com');
      expect(decoded).toContain('From: "Test Sender" <sender@example.com>');
      expect(decoded).toContain('Subject: =?UTF-8?B?VGVzdCBTdWJqZWN0?=');
      expect(decoded).toContain('X-Campaign-ID: test_campaign');
      expect(decoded).toContain('Content-Type: multipart/alternative');
      expect(decoded).toContain(Buffer.from('Hello World').toString('base64'));
    });
  });
});
