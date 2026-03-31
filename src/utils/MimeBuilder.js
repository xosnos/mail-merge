/**
 * MIME message builder for Advanced Gmail API.
 * Constructs RFC 2822 compliant raw email payloads with custom header support.
 * Handles inline images (multipart/related) and regular attachments (multipart/mixed).
 */

/**
 * Builds a raw MIME message string and returns it as web-safe base64.
 *
 * @param {Object} opts
 * @param {string} opts.to            Recipient email address
 * @param {string} opts.from          Sender email (alias or primary)
 * @param {string} [opts.senderName]  Display name for the From header
 * @param {string} [opts.replyTo]     Reply-To address
 * @param {string} [opts.cc]          CC addresses
 * @param {string} [opts.bcc]         BCC addresses
 * @param {string} opts.subject       Email subject line
 * @param {string} opts.plainBody     Plain-text body
 * @param {string} opts.htmlBody      HTML body
 * @param {Object} [opts.customHeaders]  Key-value pairs of custom headers (e.g. X-Campaign-ID)
 * @param {GoogleAppsScript.Gmail.GmailAttachment[]} [opts.attachments]  Gmail attachment objects
 * @param {Object} [opts.inlineContentIds]  Map of filename → Content-ID for inline images
 * @returns {string} Web-safe base64-encoded raw MIME message
 */
function buildMimeMessage(opts) {
  const altBoundary = 'alt_' + Utilities.getUuid().replace(/-/g, '');
  const relBoundary = 'rel_' + Utilities.getUuid().replace(/-/g, '');
  const mixBoundary = 'mix_' + Utilities.getUuid().replace(/-/g, '');

  const inlineContentIds = opts.inlineContentIds || {};
  const allAttachments = opts.attachments || [];

  // Separate inline from regular attachments
  const inlineAttachments = [];
  const regularAttachments = [];

  allAttachments.forEach(att => {
    if (inlineContentIds[att.getName()]) {
      inlineAttachments.push(att);
    } else {
      regularAttachments.push(att);
    }
  });

  const hasInline = inlineAttachments.length > 0;
  const hasRegular = regularAttachments.length > 0;

  // ---- Top-level headers ----
  const headers = [];

  if (opts.senderName) {
    headers.push('From: "' + opts.senderName.replace(/"/g, '\\"') + '" <' + opts.from + '>');
  } else {
    headers.push('From: ' + opts.from);
  }

  headers.push('To: ' + opts.to);
  headers.push('Subject: =?UTF-8?B?' + Utilities.base64Encode(opts.subject, Utilities.Charset.UTF_8) + '?=');

  if (opts.replyTo) {
    headers.push('Reply-To: ' + opts.replyTo);
  }

  if (opts.cc) {
    headers.push('Cc: ' + opts.cc);
  }

  if (opts.bcc) {
    headers.push('Bcc: ' + opts.bcc);
  }

  headers.push('MIME-Version: 1.0');

  if (opts.customHeaders) {
    Object.keys(opts.customHeaders).forEach(key => {
      headers.push(key + ': ' + opts.customHeaders[key]);
    });
  }

  // ---- Build the alternative part (text + html) ----
  const altPart = buildAlternativePart_(altBoundary, opts.plainBody, opts.htmlBody);

  // ---- Assemble body based on attachment types ----
  let body;

  if (hasInline && hasRegular) {
    // Structure: multipart/mixed
    //   ├─ multipart/related
    //   │   ├─ multipart/alternative (text + html)
    //   │   └─ inline images (Content-ID)
    //   └─ regular attachments
    headers.push('Content-Type: multipart/mixed; boundary="' + mixBoundary + '"');
    const parts = [];

    // Related section (html + inline images)
    parts.push('--' + mixBoundary);
    parts.push('Content-Type: multipart/related; boundary="' + relBoundary + '"');
    parts.push('');
    parts.push('--' + relBoundary);
    parts.push('Content-Type: multipart/alternative; boundary="' + altBoundary + '"');
    parts.push('');
    parts.push(altPart);
    parts.push('');
    inlineAttachments.forEach(att => {
      parts.push('--' + relBoundary);
      parts.push(buildAttachmentHeaders_(att, true, inlineContentIds[att.getName()]));
      parts.push('');
      parts.push(encodeAttachmentData_(att));
    });
    parts.push('--' + relBoundary + '--');
    parts.push('');

    // Regular attachments
    regularAttachments.forEach(att => {
      parts.push('--' + mixBoundary);
      parts.push(buildAttachmentHeaders_(att, false, null));
      parts.push('');
      parts.push(encodeAttachmentData_(att));
    });
    parts.push('--' + mixBoundary + '--');
    body = parts.join('\r\n');

  } else if (hasInline) {
    // Structure: multipart/related
    //   ├─ multipart/alternative (text + html)
    //   └─ inline images (Content-ID)
    headers.push('Content-Type: multipart/related; boundary="' + relBoundary + '"');
    const parts = [];

    parts.push('--' + relBoundary);
    parts.push('Content-Type: multipart/alternative; boundary="' + altBoundary + '"');
    parts.push('');
    parts.push(altPart);
    parts.push('');
    inlineAttachments.forEach(att => {
      parts.push('--' + relBoundary);
      parts.push(buildAttachmentHeaders_(att, true, inlineContentIds[att.getName()]));
      parts.push('');
      parts.push(encodeAttachmentData_(att));
    });
    parts.push('--' + relBoundary + '--');
    body = parts.join('\r\n');

  } else if (hasRegular) {
    // Structure: multipart/mixed
    //   ├─ multipart/alternative (text + html)
    //   └─ regular attachments
    headers.push('Content-Type: multipart/mixed; boundary="' + mixBoundary + '"');
    const parts = [];

    parts.push('--' + mixBoundary);
    parts.push('Content-Type: multipart/alternative; boundary="' + altBoundary + '"');
    parts.push('');
    parts.push(altPart);
    parts.push('');
    regularAttachments.forEach(att => {
      parts.push('--' + mixBoundary);
      parts.push(buildAttachmentHeaders_(att, false, null));
      parts.push('');
      parts.push(encodeAttachmentData_(att));
    });
    parts.push('--' + mixBoundary + '--');
    body = parts.join('\r\n');

  } else {
    // No attachments: just multipart/alternative
    headers.push('Content-Type: multipart/alternative; boundary="' + altBoundary + '"');
    body = altPart;
  }

  const rawMessage = headers.join('\r\n') + '\r\n\r\n' + body;
  return Utilities.base64EncodeWebSafe(Utilities.newBlob(rawMessage).getBytes());
}

/**
 * Builds the multipart/alternative section (plain + html) as base64.
 * @private
 */
function buildAlternativePart_(boundary, plainBody, htmlBody) {
  const plainB64 = Utilities.base64Encode(plainBody || '', Utilities.Charset.UTF_8);
  const htmlB64 = Utilities.base64Encode(htmlBody || '', Utilities.Charset.UTF_8);
  const plainLines = plainB64.replace(/(.{76})/g, '$1\r\n');
  const htmlLines = htmlB64.replace(/(.{76})/g, '$1\r\n');

  const parts = [];
  parts.push('--' + boundary);
  parts.push('Content-Type: text/plain; charset="UTF-8"');
  parts.push('Content-Transfer-Encoding: base64');
  parts.push('');
  parts.push(plainLines);
  parts.push('');
  parts.push('--' + boundary);
  parts.push('Content-Type: text/html; charset="UTF-8"');
  parts.push('Content-Transfer-Encoding: base64');
  parts.push('');
  parts.push(htmlLines);
  parts.push('');
  parts.push('--' + boundary + '--');
  return parts.join('\r\n');
}

/**
 * Builds MIME headers for a single attachment.
 * @private
 * @param {GoogleAppsScript.Gmail.GmailAttachment} att
 * @param {boolean} isInline  Whether this is an inline image
 * @param {string|null} contentId  The Content-ID (without angle brackets)
 * @returns {string} The header block
 */
function buildAttachmentHeaders_(att, isInline, contentId) {
  const lines = [];
  lines.push('Content-Type: ' + att.getContentType() + '; name="' + att.getName() + '"');

  if (isInline && contentId) {
    lines.push('Content-Disposition: inline; filename="' + att.getName() + '"');
    lines.push('Content-ID: <' + contentId + '>');
  } else {
    lines.push('Content-Disposition: attachment; filename="' + att.getName() + '"');
  }

  lines.push('Content-Transfer-Encoding: base64');
  return lines.join('\r\n');
}

/**
 * Base64-encodes an attachment's bytes with 76-char line wrapping.
 * @private
 * @param {GoogleAppsScript.Gmail.GmailAttachment} att
 * @returns {string}
 */
function encodeAttachmentData_(att) {
  const b64 = Utilities.base64Encode(att.getBytes());
  return b64.replace(/(.{76})/g, '$1\r\n');
}

/**
 * Extracts Content-ID mappings for inline images from a Gmail message.
 * Uses the Advanced Gmail API to read the full MIME structure.
 * @param {string} messageId  The Gmail message ID
 * @returns {Object} Map of filename → Content-ID (without angle brackets)
 */
function getInlineContentIds_(messageId) {
  try {
    const fullMsg = Gmail.Users.Messages.get('me', messageId, { format: 'full' });
    const inlineMap = {};

    const walkParts = (parts) => {
      if (!parts) return;
      for (const part of parts) {
        if (part.headers && part.filename) {
          const cidHeader = part.headers.find(h => h.name.toLowerCase() === 'content-id');
          if (cidHeader) {
            inlineMap[part.filename] = cidHeader.value.replace(/[<>]/g, '');
          }
        }
        if (part.parts) walkParts(part.parts);
      }
    };

    if (fullMsg.payload && fullMsg.payload.parts) {
      walkParts(fullMsg.payload.parts);
    }
    return inlineMap;
  } catch (e) {
    console.log('Error extracting inline content IDs: ' + e.message);
    return {};
  }
}
