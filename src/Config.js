/**
 * Global configuration and state management
 */

const CONFIG = {
  // Properties Service Keys
  KEYS: {
    SELECTED_DRAFT_ID: 'YAMM_CLONE_DRAFT_ID',
    SENDER_NAME: 'YAMM_CLONE_SENDER_NAME',
    SENDER_ALIAS: 'YAMM_CLONE_SENDER_ALIAS',
    REPLY_TO: 'YAMM_CLONE_REPLY_TO',
    EMAIL_COLUMN: 'YAMM_CLONE_EMAIL_COLUMN',
    CAMPAIGN_ID: 'YAMM_CLONE_CAMPAIGN_ID',
    LAST_PROCESSED_ROW: 'YAMM_CLONE_LAST_PROCESSED_ROW',
    BATCH_CONFIG: 'YAMM_CLONE_BATCH_CONFIG',
    SCHEDULED_BATCH_CONFIG: 'YAMM_CLONE_SCHEDULED_BATCH_CONFIG',
    ANALYTICS_TRIGGER_ID: 'YAMM_CLONE_ANALYTICS_TRIGGER_ID',
    PROGRESS_CACHE: 'YAMM_CLONE_PROGRESS'
  },
  TRACKING: {
    CENTRAL_URL: 'YOUR_CENTRAL_WEB_APP_URL_HERE',
    SECRET_KEY: 'UNAVSA_TRACKER_SECRET_KEY_2024'
  }
};

/**
 * Saves a single key-value pair to Document Properties
 * @param {string} key
 * @param {string} value
 */
function setProperty(key, value) {
  const props = PropertiesService.getDocumentProperties();
  props.setProperty(key, value);
}

/**
 * Gets a value from Document Properties
 * @param {string} key
 * @returns {string|null}
 */
function getProperty(key) {
  return PropertiesService.getDocumentProperties().getProperty(key);
}

/**
 * Clears all properties associated with the tool
 */
function clearProperties() {
  const props = PropertiesService.getDocumentProperties();
  Object.values(CONFIG.KEYS).forEach(key => {
    props.deleteProperty(key);
  });
}
