/**
 * Global configuration and state management
 */

const CONFIG = {
  // ==========================================
  // ⚠️ SET TO FALSE BEFORE PUBLISHING TO STORE ⚠️
  // ==========================================
  IS_DEV_MODE: false,

  // Properties Service Keys
  KEYS: {
    SELECTED_DRAFT_ID: 'YAMM_CLONE_DRAFT_ID',
    SENDER_NAME: 'YAMM_CLONE_SENDER_NAME',
    SENDER_ALIAS: 'YAMM_CLONE_SENDER_ALIAS',
    REPLY_TO: 'YAMM_CLONE_REPLY_TO',
    EMAIL_COLUMN: 'YAMM_CLONE_EMAIL_COLUMN',
    CAMPAIGN_ID: 'YAMM_CLONE_CAMPAIGN_ID',
    CAMPAIGN_LABEL: 'YAMM_CLONE_CAMPAIGN_LABEL',
    CAMPAIGN_LABEL_ID: 'YAMM_CLONE_CAMPAIGN_LABEL_ID',
    LAST_PROCESSED_ROW: 'YAMM_CLONE_LAST_PROCESSED_ROW',
    BATCH_CONFIG: 'YAMM_CLONE_BATCH_CONFIG',
    SCHEDULED_BATCH_CONFIG: 'YAMM_CLONE_SCHEDULED_BATCH_CONFIG',
    ANALYTICS_TRIGGER_ID: 'YAMM_CLONE_ANALYTICS_TRIGGER_ID',
    ANALYTICS_SPREADSHEET_ID: 'YAMM_CLONE_ANALYTICS_SPREADSHEET_ID',
    ANALYTICS_SHEET_NAME: 'YAMM_CLONE_ANALYTICS_SHEET_NAME',
    PROGRESS_CACHE: 'YAMM_CLONE_PROGRESS',
    LAST_BOUNCE_THREAD_TIME: 'YAMM_CLONE_LAST_BOUNCE_THREAD_TIME',
    LAST_REPLY_THREAD_TIME: 'YAMM_CLONE_LAST_REPLY_THREAD_TIME',
    USER_TIMEZONE: 'YAMM_CLONE_USER_TIMEZONE'
  },
  TRACKING: {
    get CENTRAL_URL() {
      return PropertiesService.getScriptProperties().getProperty('TRACKING_CENTRAL_URL') || '';
    },
    get SECRET_KEY() {
      return PropertiesService.getScriptProperties().getProperty('TRACKING_SECRET_KEY') || '';
    }
  }
};

/**
 * Helper to generate a composite key isolated by spreadsheet ID.
 * @param {string} key
 * @param {string} [spreadsheetId]
 * @returns {string}
 */
let _activeTriggerSpreadsheetId = null;

/**
 * Initializes the background trigger context with the mapped spreadsheet ID.
 * @param {Object} e Trigger event object
 */
function setTriggerSpreadsheetIdContext(e) {
  if (e && e.triggerUid) {
    _activeTriggerSpreadsheetId = PropertiesService.getUserProperties().getProperty(`TRIGGER_MAP_${e.triggerUid}`);
  }
}

function _getCompositeKey(key, spreadsheetId) {
  let id = spreadsheetId || _activeTriggerSpreadsheetId;
  if (!id) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) id = ss.getId();
  }
  return id ? `${id}_${key}` : key;
}

/**
 * Maps a trigger's unique ID to a spreadsheet ID so background tasks can resolve it.
 * @param {GoogleAppsScript.Script.Trigger} trigger
 * @param {string} [spreadsheetId]
 */
function mapTriggerToSpreadsheet(trigger, spreadsheetId) {
  let id = spreadsheetId;
  if (!id) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) id = ss.getId();
  }
  if (trigger && id) {
    PropertiesService.getUserProperties().setProperty(`TRIGGER_MAP_${trigger.getUniqueId()}`, id);
  }
}

/**
 * Retrieves the spreadsheet ID for a background trigger using its event object.
 * @param {Object} [e] Time-driven event object
 * @returns {string|null}
 */
function getSpreadsheetIdFromTrigger(e) {
  if (e && e.triggerUid) {
    const mapped = PropertiesService.getUserProperties().getProperty(`TRIGGER_MAP_${e.triggerUid}`);
    if (mapped) return mapped;
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss ? ss.getId() : null;
}

/**
 * Retrieves the spreadsheet ID mapped to a trigger unique ID.
 * @param {string} triggerUid
 * @returns {string|null}
 */
function getTriggerMapping(triggerUid) {
  if (!triggerUid) return null;
  return PropertiesService.getUserProperties().getProperty(`TRIGGER_MAP_${triggerUid}`);
}

/**
 * Cleans up a trigger mapping to prevent UserProperties bloat.
 * @param {string} triggerUid
 */
function deleteTriggerMapping(triggerUid) {
  if (triggerUid) {
    PropertiesService.getUserProperties().deleteProperty(`TRIGGER_MAP_${triggerUid}`);
  }
}

/**
 * Saves a single key-value pair to User Properties (per-user, prevents cross-user collisions).
 * Isolated per spreadsheet to prevent state bleed in standalone add-ons.
 * @param {string} key
 * @param {string} value
 * @param {string} [spreadsheetId]
 */
function setProperty(key, value, spreadsheetId) {
  const compositeKey = _getCompositeKey(key, spreadsheetId);
  PropertiesService.getUserProperties().setProperty(compositeKey, value);
}

/**
 * Gets a value from User Properties, isolated per spreadsheet.
 * @param {string} key
 * @param {string} [spreadsheetId]
 * @returns {string|null}
 */
function getProperty(key, spreadsheetId) {
  const compositeKey = _getCompositeKey(key, spreadsheetId);
  return PropertiesService.getUserProperties().getProperty(compositeKey);
}

/**
 * Clears all properties associated with the tool for the current user and spreadsheet.
 * @param {string} [spreadsheetId]
 */
function clearProperties(spreadsheetId) {
  const props = PropertiesService.getUserProperties();
  Object.values(CONFIG.KEYS).forEach((key) => {
    const compositeKey = _getCompositeKey(key, spreadsheetId);
    props.deleteProperty(compositeKey);
  });
}
