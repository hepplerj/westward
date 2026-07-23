// Throttled fetch with retry/backoff for cultural-heritage APIs.
// Retryable: 429, 5xx, network errors, and 200s whose body is not what we
// expected (LOC's Cloudflare serves HTML challenge pages with status 200).
// Other 4xx throw immediately.

const USER_AGENT = 'western-explorer-harvest/0.1 (jason.heppler@gmail.com)';

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export function createFetcher({
  minIntervalMs = 0,
  retries = 4,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let lastRequestAt = 0;

  async function throttled(url) {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fetchImpl(url, { headers: { 'user-agent': USER_AGENT } });
  }

  // parse(text) returns the value to resolve with, or throws to trigger a retry.
  async function fetchWithRetry(url, parse) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1));
      let res;
      try {
        res = await throttled(url);
      } catch (err) {
        lastError = err; // network error
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(res.status, url);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, url);
      const text = await res.text();
      try {
        return parse(text);
      } catch {
        lastError = new Error(`Unparseable response from ${url}`);
        continue;
      }
    }
    throw lastError;
  }

  return {
    fetchJson: (url) => fetchWithRetry(url, (text) => JSON.parse(text)),
    fetchText: (url) => fetchWithRetry(url, (text) => text),
  };
}
