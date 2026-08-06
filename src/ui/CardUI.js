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

  // Check if a future campaign is scheduled
  const scheduledTimeStr = getProperty(
    CONFIG.KEYS.SCHEDULED_TIME,
    config.spreadsheetId,
    config.sheetName
  );
  if (scheduledTimeStr) {
    const scheduledTime = parseInt(scheduledTimeStr, 10);
    if (!isNaN(scheduledTime) && scheduledTime > Date.now()) {
      const scheduledSection = CardService.newCardSection().setHeader('⏰ Campaign Scheduled');

      let subject = 'Unknown Draft';
      try {
        const savedConfigJson =
          getProperty(
            CONFIG.KEYS.SCHEDULED_CONFIG || 'YAMM_CLONE_SCHEDULED_CONFIG',
            config.spreadsheetId,
            config.sheetName
          ) || getProperty(CONFIG.KEYS.BATCH_CONFIG, config.spreadsheetId, config.sheetName);
        if (savedConfigJson) {
          const savedConfig = JSON.parse(savedConfigJson);
          const draft =
            typeof callWithBackoff === 'function'
              ? callWithBackoff(() => GmailApp.getDraft(savedConfig.draftId))
              : GmailApp.getDraft(savedConfig.draftId);
          if (draft) {
            subject = draft.getMessage().getSubject() || '(No Subject)';
          }
        }
      } catch (err) {
        // Ignore
      }

      scheduledSection.addWidget(
        CardService.newKeyValue().setTopLabel('Gmail Draft').setContent(subject)
      );

      const userTz =
        config.userTimezone ||
        (typeof getSpreadsheetTimezoneSafe === 'function' ? getSpreadsheetTimezoneSafe() : 'GMT');
      const formattedDate = Utilities.formatDate(
        new Date(scheduledTime),
        userTz,
        'yyyy-MM-dd HH:mm z'
      );

      scheduledSection.addWidget(
        CardService.newKeyValue().setTopLabel('Scheduled Time').setContent(formattedDate)
      );

      const btnRefresh = CardService.newTextButton()
        .setText('Refresh Status')
        .setOnClickAction(CardService.newAction().setFunctionName('handleRefreshUI'));

      const btnCancel = CardService.newTextButton()
        .setText('❌ Cancel Scheduled Send')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setBackgroundColor('#D93025')
        .setOnClickAction(CardService.newAction().setFunctionName('handleCancelScheduledSend'));

      scheduledSection.addWidget(
        CardService.newButtonSet().addButton(btnRefresh).addButton(btnCancel)
      );

      builder.addSection(scheduledSection);
      return builder.build();
    }
  }

  const configSection = CardService.newCardSection().setHeader('Configuration');

  // Load Data
  const draftLimit = parseInt(getProperty(CONFIG.KEYS.DRAFT_LOAD_LIMIT) || '10', 10);
  const drafts = getGmailDrafts(draftLimit);
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

  const btnSet = CardService.newButtonSet().addButton(refreshDraftsBtn);

  if (drafts.length >= draftLimit) {
    const loadMoreBtn = CardService.newTextButton()
      .setText('➕ Load More Drafts')
      .setOnClickAction(CardService.newAction().setFunctionName('handleLoadMoreDrafts'));
    btnSet.addButton(loadMoreBtn);
  }

  configSection.addWidget(draftSelect);
  configSection.addWidget(btnSet);

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

  // Schedule Send (Optional)
  configSection.addWidget(
    CardService.newDateTimePicker()
      .setTitle('Schedule Send Time (Optional)')
      .setFieldName('scheduleDate')
  );

  builder.addSection(configSection);

  // Batch Progress Section (sheet-scoped cache)
  const cache = CacheService.getUserCache();
  if (config.spreadsheetId) {
    const progressKey =
      typeof getProgressCacheKey === 'function'
        ? getProgressCacheKey(config.spreadsheetId, config.sheetName)
        : CONFIG.KEYS.PROGRESS_CACHE + '_' + config.spreadsheetId;
    let cachedProgress = cache.get(progressKey);
    if (!cachedProgress) {
      cachedProgress = cache.get(CONFIG.KEYS.PROGRESS_CACHE + '_' + config.spreadsheetId);
    }
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

function handleLoadMoreDrafts(e) {
  const config = extractConfigFromEvent(e);
  const ssId = config.spreadsheetId;
  const tabName = config.sheetName;

  let currentLimit = parseInt(getProperty(CONFIG.KEYS.DRAFT_LOAD_LIMIT, ssId, tabName) || '10', 10);
  currentLimit += 10;
  setProperty(CONFIG.KEYS.DRAFT_LOAD_LIMIT, String(currentLimit), ssId, tabName);

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
        if (input.dateTimeInput.msSinceEpoch) {
          const rawEpoch = Number(input.dateTimeInput.msSinceEpoch);
          return new Date(rawEpoch).toISOString();
        }
        return '';
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
      if (typeof rawVal === 'object') {
        if (rawVal.msSinceEpoch) {
          const rawEpoch = Number(rawVal.msSinceEpoch);
          return new Date(rawEpoch).toISOString();
        }
        return '';
      }

      if (String(rawVal) === '{}' || String(rawVal).trim() === '') {
        return '';
      }

      // Some versions of Apps Script return a string representation of an object or just a string epoch
      try {
        const parsed = JSON.parse(rawVal);
        if (parsed && typeof parsed === 'object') {
          if (parsed.msSinceEpoch) {
            const rawEpoch = Number(parsed.msSinceEpoch);
            return new Date(rawEpoch).toISOString();
          }
          return '';
        }
      } catch (err) {
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
        : e && e.userTimezone
          ? e.userTimezone
          : typeof getSpreadsheetTimezoneSafe === 'function'
            ? getSpreadsheetTimezoneSafe()
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

  // Check if a future schedule date is specified
  let isScheduled = false;
  let scheduleEpoch = 0;
  if (config.scheduleDate) {
    scheduleEpoch = new Date(config.scheduleDate).getTime();
    if (!isNaN(scheduleEpoch) && scheduleEpoch > 0) {
      isScheduled = true;
    } else {
      return CardService.newActionResponseBuilder()
        .setNotification(
          CardService.newNotification()
            .setText('Invalid scheduled date format. Please select a valid date/time.')
            .setType(CardService.NotificationType.WARNING)
        )
        .build();
    }
  }

  if (isScheduled) {
    const now = Date.now();
    if (scheduleEpoch <= now + 10000) {
      // allow a 10s grace period for tiny clock drifts
      return CardService.newActionResponseBuilder()
        .setNotification(
          CardService.newNotification()
            .setText('Scheduled time must be in the future.')
            .setType(CardService.NotificationType.WARNING)
        )
        .build();
    }

    if (typeof scheduleBatchEmails === 'function') {
      const result = scheduleBatchEmails(config, scheduleEpoch);
      const updatedCard = buildHomepageCard(e);

      return CardService.newActionResponseBuilder()
        .setNotification(
          CardService.newNotification()
            .setText(result.message)
            .setType(
              result.success
                ? CardService.NotificationType.INFO
                : CardService.NotificationType.WARNING
            )
        )
        .setNavigation(CardService.newNavigation().updateCard(updatedCard))
        .build();
    }
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

function handleCancelScheduledSend(e) {
  const config = extractConfigFromEvent(e);
  const spreadsheetId = config.spreadsheetId;
  const sheetName = config.sheetName;

  try {
    if (typeof deleteTriggerByHandler === 'function') {
      deleteTriggerByHandler('startScheduledBatchSend', spreadsheetId, sheetName);
    }

    if (typeof deleteProperty === 'function') {
      deleteProperty(CONFIG.KEYS.SCHEDULED_TIME, spreadsheetId, sheetName);
      deleteProperty(
        CONFIG.KEYS.SCHEDULED_CONFIG || 'YAMM_CLONE_SCHEDULED_CONFIG',
        spreadsheetId,
        sheetName
      );
      deleteProperty(
        CONFIG.KEYS.SCHEDULED_TRIGGER_ID || 'YAMM_CLONE_SCHEDULED_TRIGGER_ID',
        spreadsheetId,
        sheetName
      );
      deleteProperty(CONFIG.KEYS.BATCH_CONFIG, spreadsheetId, sheetName);
    }

    // Clear progress cache
    const cache = CacheService.getUserCache();
    const progressKey =
      typeof getProgressCacheKey === 'function'
        ? getProgressCacheKey(spreadsheetId, sheetName)
        : CONFIG.KEYS.PROGRESS_CACHE + '_' + spreadsheetId;
    cache.remove(progressKey);
    cache.remove(CONFIG.KEYS.PROGRESS_CACHE + '_' + spreadsheetId);

    const updatedCard = buildHomepageCard(e);

    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification()
          .setText('Scheduled campaign canceled successfully.')
          .setType(CardService.NotificationType.INFO)
      )
      .setNavigation(CardService.newNavigation().updateCard(updatedCard))
      .build();
  } catch (err) {
    if (typeof ErrorLib !== 'undefined') {
      ErrorLib.logError(err, 'handleCancelScheduledSend');
    }
    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification()
          .setText('Failed to cancel scheduled send: ' + err.message)
          .setType(CardService.NotificationType.WARNING)
      )
      .build();
  }
}
