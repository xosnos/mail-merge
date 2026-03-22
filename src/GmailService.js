/**
 * Gmail API helper functions
 */

/**
 * Retrieves all drafts from the active user's Gmail account.
 * @returns {Array<{id: string, subject: string, date: number}>}
 */
function getGmailDrafts() {
  const drafts = GmailApp.getDrafts();
  return drafts.map(draft => {
    const msg = draft.getMessage();
    return {
      id: draft.getId(),
      subject: msg.getSubject() || '(No Subject)',
      date: msg.getDate().getTime()
    };
  }).sort((a, b) => b.date - a.date); // Sort by newest first
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
  if (!draft) throw new Error("Draft not found.");
  
  const msg = draft.getMessage();
  
  // Combine all strings where variables might be used
  const contentToScan = [
    msg.getSubject(),
    msg.getBody(),
    msg.getPlainBody(),
    msg.getCc(),
    msg.getBcc(),
    msg.getTo()
  ].join(" ");
  
  // Regex to match anything inside double curly braces {{ Variable Name }}
  const regex = /\{\{(.*?)\}\}/g;
  const matches = [...contentToScan.matchAll(regex)];
  
  // Extract the capture group (name) and return unique trimmed values
  const variables = matches.map(match => match[1].trim());
  return Array.from(new Set(variables));
}
