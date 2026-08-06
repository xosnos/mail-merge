const { replaceVariables } = require('../src/services/SendEngine');

describe('SendEngine', () => {
  describe('replaceVariables', () => {
    it('should correctly replace variables in a template', () => {
      const template = 'Hello {{ First Name }} {{Last Name}}, your email is {{Email }}.';
      const headers = ['Email', 'First Name', 'Last Name'];
      const rowData = ['test@example.com', 'John', 'Doe'];

      const result = replaceVariables(template, headers, rowData);
      expect(result).toBe('Hello John Doe, your email is test@example.com.');
    });

    it('should handle missing values gracefully', () => {
      const template = 'Score: {{Score}} points.';
      const headers = ['Score'];
      const rowData = [undefined];

      const result = replaceVariables(template, headers, rowData);
      expect(result).toBe('Score:  points.');
    });

    it('should ignore non-matching variables', () => {
      const template = 'Hello {{Name}}';
      const headers = ['Age'];
      const rowData = [25];

      const result = replaceVariables(template, headers, rowData);
      expect(result).toBe('Hello {{Name}}');
    });

    it('should handle special characters in headers', () => {
      const template = 'Cost: {{Price ($)}}!';
      const headers = ['Price ($)'];
      const rowData = ['$10.00'];

      const result = replaceVariables(template, headers, rowData);
      expect(result).toBe('Cost: $10.00!');
    });

    it('should handle HTML tags inside variable placeholders', () => {
      const template =
        'Hello {{<b>First Name</b>}}, your code is {{<span style="color:red">Code</span>}}!';
      const headers = ['First Name', 'Code'];
      const rowData = ['Alice', 'XYZ123'];

      const result = replaceVariables(template, headers, rowData);
      expect(result).toBe(
        'Hello <b>Alice</b>, your code is <span style="color:red">XYZ123</span>!'
      );
    });

    it('should handle HTML entities and non-breaking spaces', () => {
      const template = 'Welcome {{First&nbsp;Name}}!';
      const headers = ['First Name'];
      const rowData = ['Bob'];

      const result = replaceVariables(template, headers, rowData);
      expect(result).toBe('Welcome Bob!');
    });

    it('should handle split braces separated by HTML tags', () => {
      const template = 'Hi {<span>{</span>First Name}<span>}</span>!';
      const headers = ['First Name'];
      const rowData = ['Charlie'];

      const result = replaceVariables(template, headers, rowData);
      expect(result).toBe('Hi Charlie!');
    });

    it('should handle Smart Chips / Hyperlink pills with rich text link URLs', () => {
      const template =
        '<p>Check out <a href="{{Document Link}}">this file</a> and {{Document Link}}</p>';
      const headers = ['Document Link'];
      const rowData = ['Q3 Proposal'];

      const mockRichText = {
        getLinkUrl: () => 'https://docs.google.com/document/d/12345/edit',
        getRuns: () => []
      };

      const result = replaceVariables(template, headers, rowData, [mockRichText]);
      expect(result).toBe(
        '<p>Check out <a href="https://docs.google.com/document/d/12345/edit">this file</a> and <a href="https://docs.google.com/document/d/12345/edit">Q3 Proposal</a></p>'
      );
    });
  });
});
