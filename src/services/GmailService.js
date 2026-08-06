/**
 * Gmail API helper functions
 */

/**
 * Retrieves a limited list of drafts from the active user's Gmail account.
 * Highly optimized to prevent timeouts on large accounts.
 * @param {number} [limit] Maximum number of drafts to load (defaults to 10)
 * @returns {Array<{id: string, subject: string, date: number}>}
 */
function getGmailDrafts(limit = 10) {
  try {
    const draftList = Gmail.Users.Drafts.list('me', { maxResults: limit });
    if (!draftList.drafts || draftList.drafts.length === 0) return [];

    const results = [];
    draftList.drafts.forEach((d) => {
      try {
        const draft = GmailApp.getDraft(d.id);
        if (draft) {
          const msg = draft.getMessage();
          results.push({
            id: d.id,
            subject: msg.getSubject() || '(No Subject)',
            date: msg.getDate().getTime()
          });
        }
      } catch (err) {
        // Ignore individual draft read failures
      }
    });
    return results.sort((a, b) => b.date - a.date);
  } catch (e) {
    console.warn(
      'Advanced Gmail Service list drafts failed, falling back to GmailApp.getDrafts():',
      e
    );
    try {
      const drafts = GmailApp.getDrafts();
      return drafts
        .slice(0, limit)
        .map((draft) => {
          const msg = draft.getMessage();
          return {
            id: draft.getId(),
            subject: msg.getSubject() || '(No Subject)',
            date: msg.getDate().getTime()
          };
        })
        .sort((a, b) => b.date - a.date);
    } catch (fallbackErr) {
      console.error('Fallback getDrafts failed:', fallbackErr);
      return [];
    }
  }
}

/**
 * Retrieves all "Send As" email aliases for the active user, including the primary email.
 * @returns {Array<string>}
 */
function getGmailAliases() {
  const primaryEmail = Session.getActiveUser().getEmail();
  const aliases = GmailApp.getAliases();

  // Return a unique array starting with the primary email
  return Array.from(new Set([primaryEmail, ...aliases]));
}

/**
 * Utility function to unescape common HTML entities and strip HTML tags from a string.
 * Used for normalizing variable names found in rich text draft content.
 * @param {string} str
 * @returns {string}
 */
function cleanVariableName_(str) {
  if (!str) return '';
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes double curly braces split by HTML tags in Gmail rich text content.
 * e.g. {<span>{</span>Var}<span>}</span> -> {{Var}}
 * @param {string} str
 * @returns {string}
 */
function normalizeBraces_(str) {
  if (!str) return '';
  return str
    .replace(/<span[^>]*>\s*\{\s*<\/span>/gi, '{')
    .replace(/<span[^>]*>\s*\}\s*<\/span>/gi, '}')
    .replace(/\{\s*<[^>]*>\s*\{/g, '{{')
    .replace(/\}\s*<[^>]*>\s*\}/g, '}}');
}

/**
 * Extracts {{variables}} from a specific draft's subject, body, CC, and BCC.
 * @param {string} draftId
 * @returns {Array<string>} List of unique variable names found.
 */
function getDraftVariables(draftId) {
  const draft = GmailApp.getDraft(draftId);
  if (!draft) throw new Error('Draft not found.');

  const msg = draft.getMessage();

  // Combine all strings where variables might be used
  const contentToScan = normalizeBraces_(
    [
      msg.getSubject(),
      msg.getBody(),
      msg.getPlainBody(),
      msg.getCc(),
      msg.getBcc(),
      msg.getTo()
    ].join(' ')
  );

  // Matches {{ ... }} inside curly braces
  const regex = /\{\{\s*([\s\S]*?)\s*\}\}/g;
  const matches = [...contentToScan.matchAll(regex)];

  // Extract clean variable names (un-escaping entities, stripping HTML tags)
  const variables = matches
    .map((match) => cleanVariableName_(match[1]))
    .filter((name) => name.length > 0);
  return Array.from(new Set(variables));
}
