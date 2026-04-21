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
      const rowData = ['10.00'];

      const result = replaceVariables(template, headers, rowData);
      expect(result).toBe('Cost: 10.00!');
    });
  });
});
