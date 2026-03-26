/**
 * CardUI.js - Builds the Workspace Add-on Card UI
 */

/**
 * Triggered automatically when the user opens the Google Sheet and clicks the Add-on icon.
 * Builds the Homepage card for the Workspace Add-on.
 * @param {Object} e - The event object.
 * @returns {CardService.Card}
 */
function buildHomepageCard(e) {
  initializeSheet();
  
  const builder = CardService.newCardBuilder();
  builder.setHeader(CardService.newCardHeader().setTitle("UNAVSA Mail Merge"));

  const configSection = CardService.newCardSection().setHeader("Configuration");

  // Load Data
  const drafts = getGmailDrafts();
  const aliases = getGmailAliases();
  const props = PropertiesService.getDocumentProperties().getProperties();
  const sheet = SpreadsheetApp.getActiveSheet();
  
  let headers = [];
  if (sheet && sheet.getLastColumn() > 0) {
    headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  }

  // Drafts Selection
  const draftSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle("Select Gmail Draft")
    .setFieldName("draftId");
    
  if (drafts.length === 0) {
    draftSelect.addItem("No Drafts Found", "", false);
  } else {
    drafts.forEach(draft => {
      draftSelect.addItem(draft.subject || "(No Subject)", draft.id, draft.id === props[CONFIG.KEYS.SELECTED_DRAFT_ID]);
    });
  }
  
  // To handle validation on change
  draftSelect.setOnChangeAction(CardService.newAction().setFunctionName("handleDraftChange"));

  const refreshDraftsBtn = CardService.newTextButton()
    .setText("🔄 Refresh Drafts")
    .setOnClickAction(CardService.newAction().setFunctionName("handleRefreshUI"));

  configSection.addWidget(draftSelect);
  configSection.addWidget(CardService.newButtonSet().addButton(refreshDraftsBtn));

  // Sender Name
  configSection.addWidget(CardService.newTextInput()
    .setTitle("Sender Name")
    .setFieldName("senderName")
    .setValue(props[CONFIG.KEYS.SENDER_NAME] || ""));

  // Sender Email
  const aliasSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle("Sender Email")
    .setFieldName("senderAlias");
    
  const savedAlias = props[CONFIG.KEYS.SENDER_ALIAS];
  aliases.forEach((alias, index) => {
    const isSelected = savedAlias ? alias === savedAlias : index === 0;
    aliasSelect.addItem(alias, alias, isSelected);
  });
  configSection.addWidget(aliasSelect);

  // Email Column
  const emailColSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle("Recipient Email Column")
    .setFieldName("emailColumn");
    
  if (headers.length === 0) {
    emailColSelect.addItem("No columns found", "", false);
  } else {
    let foundEmailCol = false;
    headers.forEach(header => {
      if (!header) return;
      const isSaved = header === props[CONFIG.KEYS.EMAIL_COLUMN];
      const isAutoEmail = !foundEmailCol && header.toLowerCase().includes('email');
      const selected = isSaved || isAutoEmail;
      if (selected) foundEmailCol = true;
      emailColSelect.addItem(header, header, selected);
    });
  }
  configSection.addWidget(emailColSelect);

  // Reply To
  configSection.addWidget(CardService.newTextInput()
    .setTitle("Reply-To Address (Optional)")
    .setFieldName("replyTo")
    .setValue(props[CONFIG.KEYS.REPLY_TO] || ""));

  builder.addSection(configSection);

  // Analytics Section
  const metrics = typeof getCampaignMetrics === 'function' ? getCampaignMetrics() : null;
  if (metrics && metrics.total > 0) {
    const analyticsSection = CardService.newCardSection().setHeader("📊 Campaign Analytics");

    // Helper to calculate percentage safely
    const getPercent = (part, total) => total > 0 ? ((part / total) * 100).toFixed(1) + "%" : "0%";

    const sentStr = `${metrics.sent + metrics.opened + metrics.bounced} / ${metrics.total}`;
    const openStr = `${metrics.opened} (${getPercent(metrics.opened, metrics.total)})`;
    const replyStr = `${metrics.replied} (${getPercent(metrics.replied, metrics.total)})`;
    const bounceStr = `${metrics.bounced} (${getPercent(metrics.bounced, metrics.total)})`;

    analyticsSection.addWidget(CardService.newKeyValue()
      .setTopLabel("Total Processed")
      .setContent(metrics.total.toString())
      .setIcon(CardService.Icon.EMAIL));

    analyticsSection.addWidget(CardService.newKeyValue()
      .setTopLabel("Opened")
      .setContent(openStr)
      .setIcon(CardService.Icon.EVENT_PER_DAY));

    analyticsSection.addWidget(CardService.newKeyValue()
      .setTopLabel("Replied")
      .setContent(replyStr)
      .setIcon(CardService.Icon.PEOPLE));

    analyticsSection.addWidget(CardService.newKeyValue()
      .setTopLabel("Bounced")
      .setContent(bounceStr)
      .setIcon(CardService.Icon.ERROR));

    builder.addSection(analyticsSection);
  }

  // Advanced Section
  const advancedSection = CardService.newCardSection().setHeader("Advanced & Analytics");

  advancedSection.addWidget(CardService.newDateTimePicker()
    .setTitle("Schedule Send (Optional)")
    .setFieldName("scheduleDate"));

  builder.addSection(advancedSection);

  // Actions Section
  const actionSection = CardService.newCardSection().setHeader("Actions");

  const btnTest = CardService.newTextButton()
    .setText("Send Test Email")
    .setOnClickAction(CardService.newAction().setFunctionName("handleTestEmail"));

  const btnSend = CardService.newTextButton()
    .setText("Send Emails")
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setBackgroundColor("#0F9D58")
    .setOnClickAction(CardService.newAction().setFunctionName("handleSendEmails"));
    
  const btnRefresh = CardService.newTextButton()
    .setText("Refresh Analytics")
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setBackgroundColor("#4285F4")
    .setOnClickAction(CardService.newAction().setFunctionName("handleRefreshAnalytics"));

  actionSection.addWidget(CardService.newButtonSet().addButton(btnTest).addButton(btnSend));
  actionSection.addWidget(btnRefresh);

  builder.addSection(actionSection);

  return builder.build();
}

/**
 * Action handlers
 */

function handleRefreshUI(e) {
  const updatedCard = buildHomepageCard(e);
  
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(updatedCard))
    .build();
}

function handleDraftChange(e) {
  const draftId = e.formInput.draftId;
  if (!draftId) return CardService.newActionResponseBuilder().build();
  
  const result = validateTemplate(draftId);
  if (result.isValid) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification()
        .setText("Template matches all columns! Ready to send.")
        .setType(CardService.NotificationType.INFO))
      .build();
  } else {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification()
        .setText("Missing Columns in Sheet: " + result.missingColumns.join(', '))
        .setType(CardService.NotificationType.WARNING))
      .build();
  }
}

function extractConfigFromEvent(e) {
  let scheduleDate = "";
  if (e.formInput.scheduleDate) {
    const rawVal = e.formInput.scheduleDate;
    if (typeof rawVal === 'object' && rawVal.msSinceEpoch) {
      scheduleDate = new Date(rawVal.msSinceEpoch).toISOString();
    } else if (typeof rawVal === 'string' && !isNaN(Number(rawVal))) {
      scheduleDate = new Date(Number(rawVal)).toISOString();
    } else if (typeof rawVal === 'object') {
      // In case CardService passes a raw object for DateTimePicker
      scheduleDate = new Date(rawVal.msSinceEpoch || Number(rawVal.value) || 0).toISOString();
    } else {
      scheduleDate = String(rawVal);
    }
  }

  return {
    draftId: e.formInput.draftId || "",
    senderName: e.formInput.senderName || "",
    senderAlias: e.formInput.senderAlias || "",
    emailColumn: e.formInput.emailColumn || "",
    replyTo: e.formInput.replyTo || "",
    scheduleDate: scheduleDate
  };
}

function handleTestEmail(e) {
  const config = extractConfigFromEvent(e);
  
  if (!config.draftId || !config.emailColumn) {
     return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification()
          .setText("Please ensure Draft and Email Column are selected.")
          .setType(CardService.NotificationType.WARNING))
        .build();
  }

  const result = sendTestEmail(config);
  
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText(result.message)
      .setType(result.success ? CardService.NotificationType.INFO : CardService.NotificationType.WARNING))
    .build();
}

function handleSendEmails(e) {
  const config = extractConfigFromEvent(e);
  
  if (!config.draftId || !config.emailColumn) {
     return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification()
          .setText("Please ensure Draft and Email Column are selected.")
          .setType(CardService.NotificationType.WARNING))
        .build();
  }
  
  let result;
  if (config.scheduleDate && config.scheduleDate !== "") {
      const ms = new Date(config.scheduleDate).getTime();
      if (!isNaN(ms) && ms > Date.now()) {
          result = scheduleBatchEmails(config);
      } else {
          result = { success: false, message: "Scheduled time must be in the future." };
      }
  } else {
      result = sendBatchEmails(config, 0);
  }

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText(result.message)
      .setType(result.success ? CardService.NotificationType.INFO : CardService.NotificationType.WARNING))
    .build();
}

function handleRefreshAnalytics(e) {
  const result = runAnalyticsScanner();
  const updatedCard = buildHomepageCard(e);
  
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification()
      .setText(result.message)
      .setType(result.success ? CardService.NotificationType.INFO : CardService.NotificationType.WARNING))
    .setNavigation(CardService.newNavigation().updateCard(updatedCard))
    .build();
}