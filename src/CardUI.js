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
  
  const config = extractConfigFromEvent(e);
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
      const draftId = draft.id;
      const selectedDraftId = config.draftId || props[CONFIG.KEYS.SELECTED_DRAFT_ID];
      draftSelect.addItem(draft.subject || "(No Subject)", draftId, draftId === selectedDraftId);
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
    .setValue(config.senderName || props[CONFIG.KEYS.SENDER_NAME] || ""));

  // Sender Email
  const aliasSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle("Sender Email")
    .setFieldName("senderAlias");
    
  const savedAlias = config.senderAlias || props[CONFIG.KEYS.SENDER_ALIAS];
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
    const savedEmailCol = config.emailColumn || props[CONFIG.KEYS.EMAIL_COLUMN];
    headers.forEach(header => {
      if (!header || header.toLowerCase() === 'merge status') return;
      const isSaved = header === savedEmailCol;
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
    .setValue(config.replyTo || props[CONFIG.KEYS.REPLY_TO] || ""));

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

  let tzOffsetMins = 0;
  if (e && e.commonEventObject && e.commonEventObject.timeZone && e.commonEventObject.timeZone.offset !== undefined) {
    tzOffsetMins = e.commonEventObject.timeZone.offset / 60000;
  } else {
    // Fallback to script/spreadsheet timezone offset
    const tz = Session.getScriptTimeZone();
    const str = Utilities.formatDate(new Date(), tz, "Z"); // e.g. "-0700"
    const sign = str.charAt(0) === '+' ? 1 : -1;
    const hours = parseInt(str.substring(1, 3), 10);
    const mins = parseInt(str.substring(3, 5), 10);
    tzOffsetMins = sign * (hours * 60 + mins);
  }

  const dateTimePicker = CardService.newDateTimePicker()
    .setTitle("Schedule Send (Optional)")
    .setFieldName("scheduleDate")
    .setOnChangeAction(CardService.newAction().setFunctionName("handleRefreshUI"));
    
  if (tzOffsetMins !== 0) {
    dateTimePicker.setTimeZoneOffsetInMins(tzOffsetMins);
  }

  if (config.scheduleDate && config.scheduleDate !== "") {
    const ms = new Date(config.scheduleDate).getTime();
    if (!isNaN(ms)) {
      dateTimePicker.setValueInMsSinceEpoch(ms);
    }
  }

  advancedSection.addWidget(dateTimePicker);

  builder.addSection(advancedSection);

  // Actions Section
  const actionSection = CardService.newCardSection().setHeader("Actions");

  const btnTest = CardService.newTextButton()
    .setText("Send Test Email")
    .setOnClickAction(CardService.newAction().setFunctionName("handleTestEmail"));

  const isScheduled = config.scheduleDate && config.scheduleDate !== "";
  const btnSendText = isScheduled ? "Schedule Emails" : "Send Emails";
  const btnSendColor = isScheduled ? "#4285F4" : "#0F9D58"; // Blue if scheduled, Green if immediate

  const btnSend = CardService.newTextButton()
    .setText(btnSendText)
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setBackgroundColor(btnSendColor)
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
  const getFormValue = (fieldName) => {
    // 1. Try commonEventObject (modern Workspace Add-on style)
    if (e && e.commonEventObject && e.commonEventObject.formInputs && e.commonEventObject.formInputs[fieldName]) {
      const input = e.commonEventObject.formInputs[fieldName];
      
      // Special handling for DateTimePicker
      if (input.dateTimeInput) {
        return input.dateTimeInput.msSinceEpoch ? new Date(Number(input.dateTimeInput.msSinceEpoch)).toISOString() : "";
      }
      
      // Standard inputs (returns array, take first element)
      const stringInputs = input.stringInputs;
      if (stringInputs && stringInputs.value && stringInputs.value.length > 0) {
        return stringInputs.value[0];
      }
    }
    
    // 2. Try legacy formInput (classic style)
    if (e && e.formInput && e.formInput[fieldName]) {
      const rawVal = e.formInput[fieldName];
      
      // Handle DateTimePicker objects in legacy formInput
      if (typeof rawVal === 'object' && rawVal.msSinceEpoch) {
        return new Date(Number(rawVal.msSinceEpoch)).toISOString();
      }
      if (typeof rawVal === 'object' && rawVal.msSinceEpoch !== undefined) {
          return new Date(Number(rawVal.msSinceEpoch)).toISOString();
      }
      
      // Some versions of Apps Script return a string representation of an object or just a string epoch
      try {
        const parsed = JSON.parse(rawVal);
        if (parsed && parsed.msSinceEpoch) {
          return new Date(Number(parsed.msSinceEpoch)).toISOString();
        }
      } catch (e) {
        // Not JSON
      }

      // If it's a numeric string epoch
      if (!isNaN(rawVal) && Number(rawVal) > 10000000000) {
        return new Date(Number(rawVal)).toISOString();
      }
      
      return String(rawVal);
    }
    
    return "";
  };

  return {
    draftId: getFormValue("draftId"),
    senderName: getFormValue("senderName"),
    senderAlias: getFormValue("senderAlias"),
    emailColumn: getFormValue("emailColumn"),
    replyTo: getFormValue("replyTo"),
    scheduleDate: getFormValue("scheduleDate")
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
      const now = Date.now();
      // Allow a 60-second grace period for "future" checks to account for UI lag/clock drift
      if (!isNaN(ms) && ms > (now - 60000)) {
          result = scheduleBatchEmails(config);
      } else {
          result = { success: false, message: `Must be future. Selected: ${new Date(ms).toISOString()}, Now: ${new Date(now).toISOString()}, Input: ${config.scheduleDate}` };
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