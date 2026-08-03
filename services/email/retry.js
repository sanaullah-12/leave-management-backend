/**
 * Retry with exponential backoff.
 *
 * Single responsibility: re-attempt work that failed for a *transient* reason,
 * and get out of the way immediately for a permanent one.
 *
 * Retrying a permanent failure is actively harmful — it delays the real error
 * reaching the logs and can trip Gmail's rate limiting or lock the account.
 */

const { log, warn } = require("./logger");

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 2000; // 2s -> 4s -> 8s

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {(attempt:number) => Promise<any>} operation
 * @param {(error:Error) => boolean} isRetryable  permanent vs transient verdict
 * @param {string} label                          what is being attempted, for logs
 */
const withRetry = async (operation, isRetryable, label = "operation") => {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`Attempt ${attempt}/${MAX_ATTEMPTS} — ${label}`);

    try {
      const result = await operation(attempt);
      if (attempt > 1) log(`✅ Succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
      return result;
    } catch (error) {
      lastError = error;

      if (!isRetryable(error)) {
        warn(`Attempt ${attempt} failed permanently — not retrying (it cannot succeed).`);
        throw error;
      }

      if (attempt === MAX_ATTEMPTS) {
        warn(`Attempt ${attempt} failed. All ${MAX_ATTEMPTS} attempts exhausted.`);
        break;
      }

      // 2s -> 4s -> 8s: gives a transient network/DNS blip room to clear
      // instead of hammering a struggling server.
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      warn(`Attempt ${attempt} failed (transient). Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }

  throw lastError;
};

module.exports = { withRetry, MAX_ATTEMPTS, BASE_DELAY_MS };
