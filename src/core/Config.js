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
    ANALYTICS_TRIGGER_ID: 'YAMM_CLONE_ANALYTICS_TRIGGER_ID',
    ANALYTICS_SPREADSHEET_ID: 'YAMM_CLONE_ANALYTICS_SPREADSHEET_ID',
    ANALYTICS_SHEET_NAME: 'YAMM_CLONE_ANALYTICS_SHEET_NAME',
    PROGRESS_CACHE: 'YAMM_CLONE_PROGRESS',
    BATCH_PROGRESS: 'YAMM_CLONE_PROGRESS',
    SCHEDULED_TIME: 'YAMM_CLONE_SCHEDULED_TIME',
    LAST_BOUNCE_THREAD_TIME: 'YAMM_CLONE_LAST_BOUNCE_THREAD_TIME',
    LAST_REPLY_THREAD_TIME: 'YAMM_CLONE_LAST_REPLY_THREAD_TIME',
    CAMPAIGN_START_TIME: 'YAMM_CLONE_CAMPAIGN_START_TIME',
    DRAFT_LOAD_LIMIT: 'YAMM_CLONE_DRAFT_LOAD_LIMIT'
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

// Background trigger context. Resolved from the trigger->tab mapping so background
// executions (which have no active spreadsheet/sheet) scope their state to the
// originating tab, exactly like the UI context does via the active sheet.
let _activeTriggerSpreadsheetId = null;
let _activeTriggerSheetName = null;

/**
 * Parses a trigger mapping value into { spreadsheetId, sheetName }.
 * Accepts the current JSON format and the legacy bare-spreadsheetId string.
 * @param {string|null} raw
 * @returns {{spreadsheetId: (string|null), sheetName: (string|null)}}
 */
function _parseTriggerMapping(raw) {
  if (!raw) return { spreadsheetId: null, sheetName: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && (parsed.s || parsed.spreadsheetId)) {
      return {
        spreadsheetId: parsed.s || parsed.spreadsheetId || null,
        sheetName: parsed.t || parsed.sheetName || null
      };
    }
  } catch (e) {
    // Legacy format: the value is a bare spreadsheet ID.
  }
  return { spreadsheetId: raw, sheetName: null };
}

/**
 * Initializes the background trigger context with the mapped spreadsheet ID and tab.
 * @param {Object} e Trigger event object
 */
function setTriggerSpreadsheetIdContext(e) {
  if (e && e.triggerUid) {
    const mapping = _parseTriggerMapping(
      PropertiesService.getUserProperties().getProperty(`TRIGGER_MAP_${e.triggerUid}`)
    );
    _activeTriggerSpreadsheetId = mapping.spreadsheetId;
    _activeTriggerSheetName = mapping.sheetName;
  }
}

/**
 * Builds a state key isolated by both spreadsheet ID and tab (sheet) name, so each
 * tab that runs a mail merge keeps fully independent campaign/resume/schedule state.
 * @param {string} key
 * @param {string} [spreadsheetId]
 * @param {string} [sheetName]
 * @returns {string}
 */
function _getCompositeKey(key, spreadsheetId, sheetName) {
  let id = spreadsheetId || _activeTriggerSpreadsheetId;
  let tab = sheetName !== undefined && sheetName !== null ? sheetName : _activeTriggerSheetName;
  if (!id || tab === undefined || tab === null) {
    try {
      if (!id) {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        if (ss) id = ss.getId();
      }
      if (tab === undefined || tab === null) {
        const sh = SpreadsheetApp.getActiveSheet();
        if (sh) tab = sh.getName();
      }
    } catch (e) {
      // No active document context (background trigger without mapping).
    }
  }
  if (!id) return key;
  return `${id}_${tab || ''}_${key}`;
}

/**
 * Maps a trigger's unique ID to its originating spreadsheet + tab so background
 * tasks can resolve and scope their state correctly.
 * @param {GoogleAppsScript.Script.Trigger} trigger
 * @param {string} [spreadsheetId]
 * @param {string} [sheetName]
 */
function mapTriggerToSpreadsheet(trigger, spreadsheetId, sheetName) {
  let id = spreadsheetId;
  let tab = sheetName;
  try {
    if (!id) {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (ss) id = ss.getId();
    }
    if (tab === undefined || tab === null) {
      const sh = SpreadsheetApp.getActiveSheet();
      if (sh) tab = sh.getName();
    }
  } catch (e) {
    // No active document context.
  }
  if (trigger && id) {
    PropertiesService.getUserProperties().setProperty(
      `TRIGGER_MAP_${trigger.getUniqueId()}`,
      JSON.stringify({ s: id, t: tab || '' })
    );
  }
}

/**
 * Retrieves the spreadsheet ID for a background trigger using its event object.
 * @param {Object} [e] Time-driven event object
 * @returns {string|null}
 */
function getSpreadsheetIdFromTrigger(e) {
  if (e && e.triggerUid) {
    const mapping = _parseTriggerMapping(
      PropertiesService.getUserProperties().getProperty(`TRIGGER_MAP_${e.triggerUid}`)
    );
    if (mapping.spreadsheetId) return mapping.spreadsheetId;
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss ? ss.getId() : null;
}

/**
 * Retrieves the tab (sheet) name for a background trigger using its event object.
 * @param {Object} [e] Time-driven event object
 * @returns {string|null}
 */
function getSheetNameFromTrigger(e) {
  if (e && e.triggerUid) {
    const mapping = _parseTriggerMapping(
      PropertiesService.getUserProperties().getProperty(`TRIGGER_MAP_${e.triggerUid}`)
    );
    if (mapping.sheetName) return mapping.sheetName;
  }
  const sh = SpreadsheetApp.getActiveSheet();
  return sh ? sh.getName() : null;
}

/**
 * Retrieves the { spreadsheetId, sheetName } mapped to a trigger unique ID.
 * @param {string} triggerUid
 * @returns {{spreadsheetId: (string|null), sheetName: (string|null)}|null}
 */
function getTriggerMapping(triggerUid) {
  if (!triggerUid) return null;
  return _parseTriggerMapping(
    PropertiesService.getUserProperties().getProperty(`TRIGGER_MAP_${triggerUid}`)
  );
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

// A send marker is considered stale (e.g. a crashed run) once it is older than the
// maximum possible execution span, so a tab can never get permanently locked.
const SEND_LOCK_STALE_MS = 7 * 60 * 1000;

/**
 * Returns the shared property store used to hold per-tab "send in progress" markers,
 * plus whether it is the document store. DocumentProperties is shared across all
 * users of a spreadsheet (the shared-sheet case); ScriptProperties is the fallback
 * for background/trigger contexts that have no active document.
 * @returns {{store: GoogleAppsScript.Properties.Properties, isDoc: boolean}}
 */
function _getSendMarkerStore_() {
  return { store: PropertiesService.getScriptProperties(), isDoc: false };
}

/**
 * Builds the marker key for a given tab. Since we always use ScriptProperties,
 * the spreadsheet ID must always be part of the key to avoid cross-spreadsheet collisions.
 */
function _sendMarkerKey_(isDoc, spreadsheetId, sheetName) {
  const tab = sheetName || '';
  return `SENDING_${spreadsheetId || ''}_${tab}`;
}

/**
 * Acquires a per-tab send marker so only one send runs against a given tab at a time,
 * while sends against other tabs (or other spreadsheets) proceed concurrently. The
 * test-and-set is guarded by a brief LockService lock so it is atomic across users.
 *
 * @param {string} [spreadsheetId]
 * @param {string} [sheetName]
 * @returns {Object|null} An opaque marker to pass to releaseSendLock_, or null if a
 *   send is already active on this tab (or the marker could not be acquired).
 */
function acquireSendLock_(spreadsheetId, sheetName) {
  const now = Date.now();
  const { store, isDoc } = _getSendMarkerStore_();
  const flagKey = _sendMarkerKey_(isDoc, spreadsheetId, sheetName);

  // Brief atomic gate for the test-and-set only (held for milliseconds).
  let gate;
  try {
    gate = LockService.getDocumentLock();
  } catch (e) {
    gate = null;
  }
  if (!gate) {
    try {
      gate = LockService.getScriptLock();
    } catch (e) {
      gate = null;
    }
  }
  if (gate) {
    try {
      if (!gate.tryLock(8000)) return null;
    } catch (e) {
      gate = null;
    }
  }

  try {
    const existing = store.getProperty(flagKey);
    if (existing) {
      const ts = parseInt(existing, 10);
      if (!isNaN(ts) && now - ts < SEND_LOCK_STALE_MS) {
        return null; // Another send is active on this tab.
      }
    }
    store.setProperty(flagKey, String(now));
    return { isDoc, flagKey };
  } finally {
    if (gate) {
      try {
        gate.releaseLock();
      } catch (e) {
        // Ignore release failures.
      }
    }
  }
}

/**
 * Releases a per-tab send marker acquired via acquireSendLock_.
 * @param {Object|null} marker
 */
function releaseSendLock_(marker) {
  if (!marker) return;
  try {
    const store = PropertiesService.getScriptProperties();
    if (store) store.deleteProperty(marker.flagKey);
  } catch (e) {
    // Ignore; a stale marker self-expires via SEND_LOCK_STALE_MS.
  }
}

/**
 * Registers a tab as having an active campaign for the spreadsheet, so the single
 * per-spreadsheet analytics scanner knows to scan every tab that has been sent.
 * The registry is spreadsheet-scoped (not tab-scoped) on purpose.
 * @param {string} spreadsheetId
 * @param {string} sheetName
 */
function registerCampaignTab_(spreadsheetId, sheetName) {
  if (!spreadsheetId || !sheetName) return;
  const key = _getCompositeKey('YAMM_CLONE_CAMPAIGN_TABS', spreadsheetId, '');
  const props = PropertiesService.getUserProperties();
  let tabs;
  try {
    tabs = JSON.parse(props.getProperty(key) || '[]');
  } catch (e) {
    tabs = [];
  }
  if (tabs.indexOf(sheetName) === -1) {
    tabs.push(sheetName);
    props.setProperty(key, JSON.stringify(tabs));
  }
}

/**
 * Unregisters a tab from having an active campaign, so when all campaigns on
 * a spreadsheet expire (older than 7 days), the background analytics trigger is cleaned up.
 * @param {string} spreadsheetId
 * @param {string} sheetName
 */
function unregisterCampaignTab_(spreadsheetId, sheetName) {
  if (!spreadsheetId || !sheetName) return;
  const key = _getCompositeKey('YAMM_CLONE_CAMPAIGN_TABS', spreadsheetId, '');
  const props = PropertiesService.getUserProperties();
  let tabs;
  try {
    tabs = JSON.parse(props.getProperty(key) || '[]');
  } catch (e) {
    tabs = [];
  }
  const index = tabs.indexOf(sheetName);
  if (index !== -1) {
    tabs.splice(index, 1);
    if (tabs.length === 0) {
      props.deleteProperty(key);
    } else {
      props.setProperty(key, JSON.stringify(tabs));
    }
  }
}

/**
 * Returns the list of tab names with active campaigns for a spreadsheet.
 * @param {string} spreadsheetId
 * @returns {string[]}
 */
function getCampaignTabs_(spreadsheetId) {
  const key = _getCompositeKey('YAMM_CLONE_CAMPAIGN_TABS', spreadsheetId, '');
  try {
    return JSON.parse(PropertiesService.getUserProperties().getProperty(key) || '[]');
  } catch (e) {
    return [];
  }
}

/**
 * Saves a single key-value pair to User Properties (per-user, prevents cross-user collisions).
 * Isolated per spreadsheet AND tab so each tab keeps independent state.
 * @param {string} key
 * @param {string} value
 * @param {string} [spreadsheetId]
 * @param {string} [sheetName]
 */
function setProperty(key, value, spreadsheetId, sheetName) {
  const compositeKey = _getCompositeKey(key, spreadsheetId, sheetName);
  PropertiesService.getUserProperties().setProperty(compositeKey, value);
}

/**
 * Deletes a property associated with the tool for the current user, spreadsheet, and tab.
 * @param {string} key
 * @param {string} [spreadsheetId]
 * @param {string} [sheetName]
 */
function deleteProperty(key, spreadsheetId, sheetName) {
  const compositeKey = _getCompositeKey(key, spreadsheetId, sheetName);
  PropertiesService.getUserProperties().deleteProperty(compositeKey);
}

/**
 * Sets multiple properties at once using a single batch RPC request.
 * Isolated per spreadsheet and tab.
 * @param {Object<string, string>} propertiesMap
 * @param {string} [spreadsheetId]
 * @param {string} [sheetName]
 */
function setPropertiesBatch(propertiesMap, spreadsheetId, sheetName) {
  const compositeMap = {};
  Object.keys(propertiesMap).forEach((key) => {
    const compositeKey = _getCompositeKey(key, spreadsheetId, sheetName);
    compositeMap[compositeKey] = propertiesMap[key];
  });
  PropertiesService.getUserProperties().setProperties(compositeMap);
}

/**
 * Gets a value from User Properties, isolated per spreadsheet and tab.
 * @param {string} key
 * @param {string} [spreadsheetId]
 * @param {string} [sheetName]
 * @returns {string|null}
 */
function getProperty(key, spreadsheetId, sheetName) {
  const compositeKey = _getCompositeKey(key, spreadsheetId, sheetName);
  const val = PropertiesService.getUserProperties().getProperty(compositeKey);
  if (val !== null && val !== undefined) {
    return val;
  }

  // Legacy key fallback: check key without sheetName/tab scope (2-segment key).
  let id = spreadsheetId || _activeTriggerSpreadsheetId;
  if (!id) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (ss) id = ss.getId();
    } catch (e) {
      // Ignore
    }
  }
  if (id) {
    const legacyKey = `${id}_${key}`;
    return PropertiesService.getUserProperties().getProperty(legacyKey);
  }
  return null;
}

/**
 * Clears all properties associated with the tool for the current user, spreadsheet, and tab.
 * @param {string} [spreadsheetId]
 * @param {string} [sheetName]
 */
function clearProperties(spreadsheetId, sheetName) {
  const props = PropertiesService.getUserProperties();
  Object.values(CONFIG.KEYS).forEach((key) => {
    const compositeKey = _getCompositeKey(key, spreadsheetId, sheetName);
    props.deleteProperty(compositeKey);
  });
}

/**
 * Computes the timezone offset in milliseconds for a given date and timezone ID.
 * @param {Date} date
 * @param {string} tzId Timezone ID (e.g. "America/Los_Angeles")
 * @returns {number} Offset in milliseconds
 */
function getTimezoneOffsetMs(date, tzId) {
  try {
    if (!tzId) return 0;
    const formatted = Utilities.formatDate(date, tzId, 'Z'); // e.g. "-0700", "+0530"
    const sign = formatted.charAt(0) === '-' ? -1 : 1;
    const hours = parseInt(formatted.substring(1, 3), 10);
    const minutes = parseInt(formatted.substring(3, 5), 10);
    return sign * (hours * 60 + minutes) * 60 * 1000;
  } catch (err) {
    console.error('Failed to parse timezone offset for ' + tzId, err);
    return 0;
  }
}
