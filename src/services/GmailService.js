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
    console.warn('Advanced Gmail Service list drafts failed, falling back to GmailApp.getDrafts():', e);
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
 * Extracts {{variables}} from a specific draft's subject, body, CC, and BCC.
 * @param {string} draftId
 * @returns {Array<string>} List of unique variable names found.
 */
function getDraftVariables(draftId) {
  const draft = GmailApp.getDraft(draftId);
  if (!draft) throw new Error('Draft not found.');

  const msg = draft.getMessage();

  // Combine all strings where variables might be used
  const contentToScan = [
    msg.getSubject(),
    msg.getBody(),
    msg.getPlainBody(),
    msg.getCc(),
    msg.getBcc(),
    msg.getTo()
  ].join(' ');

  // Regex to match anything inside double curly braces {{ Variable Name }}
  const regex = /\{\{(.*?)\}\}/g;
  const matches = [...contentToScan.matchAll(regex)];

  // Extract the capture group (name) and return unique trimmed values
  const variables = matches.map((match) => match[1].trim());
  return Array.from(new Set(variables));
}
