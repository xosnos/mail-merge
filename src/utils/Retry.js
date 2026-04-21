/**
 * Executes a function with exponential backoff.
 * Useful for handling Google API 429 Too Many Requests errors.
 *
 * @param {Function} func The function to execute.
 * @param {number} [maxRetries=5] Maximum number of retries.
 * @param {number} [baseDelayMs=1000] Initial delay in milliseconds.
 * @returns {*} The result of the executed function.
 */
function callWithBackoff(func, maxRetries = 5, baseDelayMs = 1000) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return func();
    } catch (e) {
      const isRetryable =
        e.message &&
        (e.message.indexOf('Too many concurrent requests') > -1 ||
          e.message.indexOf('Service invoked too many times') > -1 ||
          e.message.indexOf('Rate limit exceeded') > -1 ||
          e.message.indexOf('Limit Exceeded') > -1 ||
          e.message.indexOf('Quota exceeded') > -1);

      if (isRetryable && attempt < maxRetries) {
        attempt++;
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
        Utilities.sleep(delay);
      } else {
        throw e; // Rethrow if it's not retryable or we hit max retries
      }
    }
  }
}
