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

  // Dynamic Title Based on Dev Mode
  const title = CONFIG.IS_DEV_MODE ? '🛠️ UNAVSA Mail Merge [DEV]' : 'UNAVSA Mail Merge';
  builder.setHeader(CardService.newCardHeader().setTitle(title));

  const configSection = CardService.newCardSection().setHeader('Configuration');

  // Load Data
  const drafts = getGmailDrafts();
  const aliases = getGmailAliases();
  // Saved config is read per-user AND per-tab via getProperty (resolves the active
  // spreadsheet + sheet), so each tab pre-populates its own last-used settings.
  const sheet = SpreadsheetApp.getActiveSheet();

  let headers = [];
  if (sheet && sheet.getLastColumn() > 0) {
    headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map((h) => String(h).trim());
  }

  // Drafts Selection
  const draftSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle('Select Gmail Draft')
    .setFieldName('draftId');

  if (drafts.length === 0) {
    draftSelect.addItem('No Drafts Found', '', false);
  } else {
    const selectedDraftId = config.draftId || getProperty(CONFIG.KEYS.SELECTED_DRAFT_ID);
    drafts.forEach((draft) => {
      const draftId = draft.id;
      draftSelect.addItem(draft.subject || '(No Subject)', draftId, draftId === selectedDraftId);
    });
  }

  // To handle validation on change
  draftSelect.setOnChangeAction(CardService.newAction().setFunctionName('handleDraftChange'));

  const refreshDraftsBtn = CardService.newTextButton()
    .setText('🔄 Refresh Drafts')
    .setOnClickAction(CardService.newAction().setFunctionName('handleRefreshUI'));

  configSection.addWidget(draftSelect);
  configSection.addWidget(CardService.newButtonSet().addButton(refreshDraftsBtn));

  // Sender Name
  configSection.addWidget(
    CardService.newTextInput()
      .setTitle('Sender Name')
      .setFieldName('senderName')
      .setHint('e.g. UNAVSA-21 Registration')
      .setValue(config.senderName || getProperty(CONFIG.KEYS.SENDER_NAME) || '')
  );

  // Sender Email
  const aliasSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle('Sender Email')
    .setFieldName('senderAlias');

  const savedAlias = config.senderAlias || getProperty(CONFIG.KEYS.SENDER_ALIAS);
  aliases.forEach((alias, index) => {
    const isSelected = savedAlias ? alias === savedAlias : index === 0;
    aliasSelect.addItem(alias, alias, isSelected);
  });
  configSection.addWidget(aliasSelect);

  // Email Column
  const emailColSelect = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle('Recipient Email Column')
    .setFieldName('emailColumn');

  if (headers.length === 0) {
    emailColSelect.addItem('No columns found', '', false);
  } else {
    let foundEmailCol = false;
    const savedEmailCol = config.emailColumn || getProperty(CONFIG.KEYS.EMAIL_COLUMN);
    headers.forEach((header) => {
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
  configSection.addWidget(
    CardService.newTextInput()
      .setTitle('Reply-To Address (Optional)')
      .setFieldName('replyTo')
      .setHint('e.g. conference.registration@unavsa.org')
      .setValue(config.replyTo || getProperty(CONFIG.KEYS.REPLY_TO) || '')
  );

  builder.addSection(configSection);

  // Batch Progress Section (user-scoped cache)
  const cache = CacheService.getUserCache();
  if (config.spreadsheetId) {
    const cachedProgress = cache.get(CONFIG.KEYS.BATCH_PROGRESS + '_' + config.spreadsheetId);
    if (cachedProgress) {
      try {
        const progress = JSON.parse(cachedProgress);
        const progressSection = CardService.newCardSection().setHeader('🚀 Active Batch Progress');

        progressSection.addWidget(
          CardService.newKeyValue()
            .setTopLabel('Status')
            .setContent(progress.status || 'Running')
        );

        progressSection.addWidget(
          CardService.newKeyValue()
            .setTopLabel('Processed')
            .setContent(`${progress.processed} / ${progress.total}`)
        );

        if (progress.errors > 0) {
          progressSection.addWidget(
            CardService.newKeyValue().setTopLabel('Errors').setContent(progress.errors.toString())
          );
        }

        const btnRefreshProgress = CardService.newTextButton()
          .setText('Refresh Progress')
          .setOnClickAction(CardService.newAction().setFunctionName('handleRefreshUI'));

        progressSection.addWidget(CardService.newButtonSet().addButton(btnRefreshProgress));

        builder.addSection(progressSection);
      } catch (err) {
        // Ignore invalid cache JSON
      }
    }
  }

  // Actions Section
  const actionSection = CardService.newCardSection().setHeader('Actions');

  const btnTest = CardService.newTextButton()
    .setText('Send Test Email')
    .setOnClickAction(CardService.newAction().setFunctionName('handleTestEmail'));

  const btnSend = CardService.newTextButton()
    .setText('Send Emails')
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setBackgroundColor('#0F9D58')
    .setOnClickAction(CardService.newAction().setFunctionName('handleSendEmails'));

  actionSection.addWidget(CardService.newButtonSet().addButton(btnTest).addButton(btnSend));

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
      .setNotification(
        CardService.newNotification()
          .setText('Template matches all columns! Ready to send.')
          .setType(CardService.NotificationType.INFO)
      )
      .build();
  } else {
    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification()
          .setText('Missing Columns in Sheet: ' + result.missingColumns.join(', '))
          .setType(CardService.NotificationType.WARNING)
      )
      .build();
  }
}

function extractConfigFromEvent(e) {
  const getFormValue = (fieldName) => {
    // 1. Try commonEventObject (modern Workspace Add-on style)
    if (
      e &&
      e.commonEventObject &&
      e.commonEventObject.formInputs &&
      e.commonEventObject.formInputs[fieldName]
    ) {
      const input = e.commonEventObject.formInputs[fieldName];

      // Special handling for DateTimePicker
      if (input.dateTimeInput) {
        return input.dateTimeInput.msSinceEpoch
          ? new Date(Number(input.dateTimeInput.msSinceEpoch)).toISOString()
          : '';
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

    return '';
  };

  return {
    draftId: getFormValue('draftId'),
    senderName: getFormValue('senderName'),
    senderAlias: getFormValue('senderAlias'),
    emailColumn: getFormValue('emailColumn'),
    replyTo: getFormValue('replyTo'),
    scheduleDate: getFormValue('scheduleDate'),
    userTimezone:
      e && e.commonEventObject && e.commonEventObject.timeZone && e.commonEventObject.timeZone.id
        ? e.commonEventObject.timeZone.id
        : '',
    spreadsheetId: SpreadsheetApp.getActiveSpreadsheet()
      ? SpreadsheetApp.getActiveSpreadsheet().getId()
      : null,
    sheetName: SpreadsheetApp.getActiveSheet() ? SpreadsheetApp.getActiveSheet().getName() : null
  };
}

function handleTestEmail(e) {
  const config = extractConfigFromEvent(e);

  if (!config.draftId || !config.emailColumn) {
    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification()
          .setText('Please ensure Draft and Email Column are selected.')
          .setType(CardService.NotificationType.WARNING)
      )
      .build();
  }

  const result = sendTestEmail(config);

  return CardService.newActionResponseBuilder()
    .setNotification(
      CardService.newNotification()
        .setText(result.message)
        .setType(
          result.success ? CardService.NotificationType.INFO : CardService.NotificationType.WARNING
        )
    )
    .build();
}

function handleSendEmails(e) {
  const config = extractConfigFromEvent(e);

  if (!config.draftId || !config.emailColumn) {
    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification()
          .setText('Please ensure Draft and Email Column are selected.')
          .setType(CardService.NotificationType.WARNING)
      )
      .build();
  }

  const result = startBackgroundBatchEmails(config);

  return CardService.newActionResponseBuilder()
    .setNotification(
      CardService.newNotification()
        .setText(result.message)
        .setType(
          result.success ? CardService.NotificationType.INFO : CardService.NotificationType.WARNING
        )
    )
    .build();
}
