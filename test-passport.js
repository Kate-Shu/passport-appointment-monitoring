const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Set PASSPORT_SERVICE to the exact service label or option value (in .env or the shell).
// Verify safely: node test-passport.js --dry-run
// Without --dry-run, events go to the existing N8N_WEBHOOK_URL using x-monitor-key.
// n8n should send only CHECK_RESULT events to Telegram, using message / details.slots.
const QUEUE_URL = 'https://respublika.pasport.org.ua/solutions/e-queue';
const CENTER = 'Київ, ТРЦ Respublika Park, вул. Кільцева дорога, 1';
const RESULT = Object.freeze({ NO_SLOTS: 'NO_SLOTS', SLOTS_FOUND: 'SLOTS_FOUND', CHECK_FAILED: 'CHECK_FAILED' });
const LABELS = {
  service: /послуга|service/i,
  day: /обрати день|оберіть день|choose (?:a )?day|select (?:a )?day/i,
  time: /обрати час|оберіть час|choose (?:a )?time|select (?:a )?time/i,
};
const EMPTY = /наразі всі місця зайняті|вільних місць немає|немає (?:вільних|доступних) (?:місць|дат|днів|годин)|немає доступного часу|no (?:available )?(?:slots|appointments|dates|days|times)(?: available)?/i;
const PLACEHOLDER = /^(?:[-–—\s]+$|(?:обрати|оберіть|виберіть|choose|select)(?:\s|$)|loading|завантаж)/iu;
const LOADING = /loading|завантаж/i;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class CheckError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = 'CheckError';
    this.details = details;
  }
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.origin + parsed.pathname;
  } catch { return null; }
}

function formatResult(result, details) {
  if (result === RESULT.NO_SLOTS) return 'Вільних місць немає';
  if (result === RESULT.CHECK_FAILED) return 'Не вдалося перевірити доступність';
  if (result !== RESULT.SLOTS_FOUND || !details.slots?.length) throw new CheckError('INVALID_RESULT');
  return details.slots.map(slot =>
    `Знайдено місце: ${details.center}, ${details.service}, ${slot.date}, ${slot.time}`
  ).join('\n');
}

function outcome(result, details, httpStatus = null) {
  return { result, message: formatResult(result, details), httpStatus,
    details: { ...details, checked_at: new Date().toISOString() } };
}

function realOptions(snapshot) {
  return snapshot.options.filter(option =>
    option.value.trim() && !option.disabled && !option.hidden && option.text.trim() &&
    !PLACEHOLDER.test(option.text) && !EMPTY.test(option.text)
  );
}

function validDate(option) {
  // Validate the displayed date: a valid option value cannot make an error label a date.
  let parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(option.text);
  if (!parts) {
    const local = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(option.text);
    if (local) parts = [local[0], local[3], local[2], local[1]];
  }
  if (!parts) return false;
  const [year, month, day] = parts.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTime(text) {
  return /^(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[-–—]\s*(?:[01]?\d|2[0-3]):[0-5]\d)?$/.test(text);
}

// Watch dependent option mutations; require a completed data request as well below.
async function readSelect(locator) {
  return locator.evaluate(element => {
    if (!element.__passportMonitor) {
      const state = { id: `${Date.now()}-${Math.random()}`, revision: 0 };
      const observer = new MutationObserver(records => {
        if (records.some(record => record.type !== 'attributes' || record.target !== element)) state.revision += 1;
      });
      observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['value', 'label', 'disabled', 'hidden'] });
      element.__passportMonitor = state;
    }
    return {
      id: element.__passportMonitor.id, revision: element.__passportMonitor.revision,
      disabled: element.disabled, busy: Boolean(element.closest('[aria-busy="true"]')), value: element.value,
      options: [...element.options].map(option => ({
        value: option.value, text: (option.label || option.textContent).trim(),
        disabled: option.disabled || Boolean(option.closest('optgroup[disabled]')), hidden: option.hidden,
      })),
    };
  });
}

async function emptyMessage(scope) {
  if (!scope) return '';
  return scope.getByText(EMPTY).evaluateAll(elements => elements.filter(element =>
    element.tagName !== 'OPTION' && element.tagName !== 'SELECT' && element.getClientRects().length &&
    getComputedStyle(element).visibility !== 'hidden'
  ).map(element => element.textContent.trim()).join('\n'));
}

function trackHealth(page, url) {
  const pending = new Set();
  const requestSequence = new Map();
  let started = 0;
  let completed = 0;
  let failure = null;
  const origin = new URL(url).origin;
  const relevant = request => {
    const requestUrl = new URL(request.url());
    if (/google-analytics|googletagmanager|doubleclick|analytics\.google/.test(requestUrl.hostname)) return false;
    return ['xhr', 'fetch'].includes(request.resourceType()) ||
      (requestUrl.origin === origin && ['document', 'script'].includes(request.resourceType()));
  };
  const listeners = {
    request: request => {
      if (relevant(request)) {
        pending.add(request);
        if (['xhr', 'fetch'].includes(request.resourceType())) requestSequence.set(request, ++started);
      }
    },
    requestfinished: request => {
      completed = Math.max(completed, requestSequence.get(request) || 0);
      requestSequence.delete(request);
      pending.delete(request);
    },
    requestfailed: request => {
      if (relevant(request)) failure = 'AVAILABILITY_REQUEST_FAILED';
      requestSequence.delete(request);
      pending.delete(request);
    },
    response: response => {
      if (relevant(response.request()) && response.status() >= 400) failure = `AVAILABILITY_HTTP_${response.status()}`;
    },
    pageerror: () => { failure = 'PAGE_JAVASCRIPT_ERROR'; },
    crash: () => { failure = 'PAGE_CRASHED'; },
  };
  for (const [event, listener] of Object.entries(listeners)) page.on(event, listener);
  return {
    pending,
    mark() { return started; },
    refreshedSince(mark) { return completed > mark; },
    assert() { if (failure) throw new CheckError(failure); },
    dispose() { for (const [event, listener] of Object.entries(listeners)) page.off(event, listener); },
  };
}

async function assertPage(page, health) {
  const title = await page.title();
  const body = await page.locator('body').innerText({ timeout: 1000 });
  if (/just a moment|attention required|security verification/i.test(title) ||
      /verify you are human|verifying you are human|checking your browser/i.test(body) ||
      await page.locator('iframe[src*="challenges.cloudflare.com"]').count()) throw new CheckError('CLOUDFLARE_BLOCKED');
  health.assert();
}

async function findSelect(page, field, config, deadline) {
  const locator = config.selectors?.[field] ? page.locator(config.selectors[field])
    : page.getByLabel(LABELS[field]).and(page.locator('select'));
  await locator.waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) });
  if (await locator.count() !== 1) throw new CheckError(`AMBIGUOUS_${field.toUpperCase()}_FIELD`);
  return locator;
}

async function waitForOptions(page, locator, { before, health, deadline, emptyScope, previousEmptyText = '', requestMark }) {
  let stableKey = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    await assertPage(page, health);
    const snapshot = await readSelect(locator);
    const options = realOptions(snapshot);
    const optionText = snapshot.options.map(option => option.text).join('\n');
    const emptyText = await emptyMessage(emptyScope);
    const fresh = !before || snapshot.id !== before.id || snapshot.revision > before.revision ||
      JSON.stringify(snapshot.options) !== JSON.stringify(before.options);
    const newEmptyMessage = emptyText !== previousEmptyText && EMPTY.test(emptyText);
    // Empty/loading selectors are inconclusive; an explicit response is required for NO_SLOTS.
    const explicitEmpty = EMPTY.test(optionText) || newEmptyMessage;
    const refreshed = requestMark === undefined || health.refreshedSince(requestMark);
    const ready = refreshed && (fresh || newEmptyMessage) && !snapshot.busy && health.pending.size === 0 &&
      !LOADING.test(optionText) && ((options.length && !snapshot.disabled) || explicitEmpty);
    const key = JSON.stringify({ options: snapshot.options, revision: snapshot.revision, emptyText });
    if (ready) {
      if (key !== stableKey) { stableKey = key; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 300) {
        if (options.length && explicitEmpty) throw new CheckError('CONTRADICTORY_AVAILABILITY');
        return { options, empty: explicitEmpty };
      }
    } else stableKey = null;
    await pause(100);
  }
  throw new CheckError('AVAILABILITY_NOT_CONFIRMED');
}

async function checkAvailability(page, options = {}) {
  const config = { url: QUEUE_URL, center: CENTER, service: '', timeoutMs: 15000,
    totalTimeoutMs: 90000, selectors: {}, ...options };
  const deadline = Date.now() + config.totalTimeoutMs;
  const stageDeadline = () => Math.min(deadline, Date.now() + config.timeoutMs);
  const remaining = () => Math.max(1, Math.min(config.timeoutMs, deadline - Date.now()));
  const details = { center: config.center, service: config.service || null, slots: [] };
  const health = trackHealth(page, config.url);
  let httpStatus = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void page.close().catch(() => {});
  }, config.totalTimeoutMs);
  try {
    page.setDefaultTimeout(config.timeoutMs);
    const response = await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: remaining() });
    httpStatus = response?.status() ?? null;
    if (httpStatus === 403 || httpStatus === 429) throw new CheckError('ACCESS_BLOCKED');
    if (httpStatus === null || httpStatus >= 400) throw new CheckError('PAGE_LOAD_FAILED');
    await assertPage(page, health);
    const serviceField = await findSelect(page, 'service', config, stageDeadline());
    const services = await waitForOptions(page, serviceField, { health, deadline: stageDeadline() });
    const matches = config.service
      ? services.options.filter(option => option.value === config.service || option.text === config.service)
      : services.options.length === 1 ? services.options : [];
    if (matches.length !== 1) throw new CheckError(config.service ? 'SERVICE_NOT_FOUND' : 'SERVICE_NOT_CONFIGURED', {
      available_services: services.options.map(option => ({ value: option.value, label: option.text })),
    });
    const service = matches[0];
    details.service = service.text;
    details.service_value = service.value;
    const dayField = await findSelect(page, 'day', config, stageDeadline());
    const dayBefore = await readSelect(dayField);
    const form = serviceField.locator('xpath=ancestor::form[1]');
    const emptyScope = await form.count() === 1 ? form : page.locator('body');
    const previousEmptyText = await emptyMessage(emptyScope);
    const dayRequestMark = health.mark();
    await serviceField.selectOption(service.value, { timeout: remaining() });
    const days = await waitForOptions(page, dayField, {
      before: dayBefore, health, deadline: stageDeadline(), emptyScope, previousEmptyText, requestMark: dayRequestMark,
    });
    if (await serviceField.inputValue() !== service.value) throw new CheckError('SERVICE_CHANGED');
    if (Date.now() >= deadline) throw new CheckError('CHECK_TIMEOUT');
    if (days.empty) return outcome(RESULT.NO_SLOTS, details, httpStatus);
    const timeField = await findSelect(page, 'time', config, stageDeadline());
    for (const day of days.options) {
      if (Date.now() >= deadline) throw new CheckError('CHECK_TIMEOUT');
      if (!validDate(day)) throw new CheckError('UNRECOGNIZED_DATE');
      const timeBefore = await readSelect(timeField);
      const previousTimeEmptyText = await emptyMessage(emptyScope);
      const timeRequestMark = health.mark();
      await dayField.selectOption(day.value, { timeout: remaining() });
      const times = await waitForOptions(page, timeField, {
        before: timeBefore, health, deadline: stageDeadline(), emptyScope, previousEmptyText: previousTimeEmptyText,
        requestMark: timeRequestMark,
      });
      if (await serviceField.inputValue() !== service.value || await dayField.inputValue() !== day.value) {
        throw new CheckError('SELECTION_CHANGED');
      }
      for (const time of times.options) {
        if (!validTime(time.text)) throw new CheckError('UNRECOGNIZED_TIME');
        details.slots.push({ date: day.text, time: time.text, date_value: day.value, time_value: time.value });
      }
    }
    await assertPage(page, health);
    if (Date.now() >= deadline) throw new CheckError('CHECK_TIMEOUT');
    details.slots = [...new Map(details.slots.map(slot => [`${slot.date_value}\0${slot.time_value}`, slot])).values()];
    return outcome(details.slots.length ? RESULT.SLOTS_FOUND : RESULT.NO_SLOTS, details, httpStatus);
  } catch (error) {
    return outcome(RESULT.CHECK_FAILED, {
      ...details, slots: [], reason: timedOut ? 'CHECK_TIMEOUT' : error instanceof CheckError ? error.message : error.name,
      ...(error.details || {}),
    }, httpStatus);
  } finally { clearTimeout(timer); health.dispose(); }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function run(options = {}) {
  const env = options.env || process.env;
  const dryRun = options.dryRun ?? env.PASSPORT_DRY_RUN === '1';
  const log = options.log || console.log;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const runId = `run_${randomUUID()}`;
  const pending = new Set();
  let deliveryFailed = false;
  let browser;
  let result;
  const config = {
    url: QUEUE_URL, center: CENTER, service: (env.PASSPORT_SERVICE || '').trim(),
    timeoutMs: positiveNumber(env.PASSPORT_TIMEOUT_MS, 15000),
    totalTimeoutMs: positiveNumber(env.PASSPORT_TOTAL_TIMEOUT_MS, 90000),
    selectors: { service: env.PASSPORT_SERVICE_SELECTOR, day: env.PASSPORT_DAY_SELECTOR, time: env.PASSPORT_TIME_SELECTOR },
  };
  async function emit(data) {
    const event = {
      event_id: `evt_${randomUUID()}`, tenant_id: env.TENANT_ID || 'passport_project',
      bot_id: env.BOT_ID || 'respublika_passport_bot', run_id: runId,
      occurred_at: new Date().toISOString(), level: 'INFO', result: null,
      http_method: null, http_status: null, resource_type: null, url: null, details: {}, ...data,
    };
    log(JSON.stringify(event));
    if (dryRun) return;
    if (!env.N8N_WEBHOOK_URL || !env.N8N_WEBHOOK_SECRET) {
      deliveryFailed = true;
      log('[N8N_LOG_DELIVERY_ERROR] Webhook URL or secret is missing');
      return;
    }
    try {
      const response = await fetchImpl(env.N8N_WEBHOOK_URL, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-monitor-key': env.N8N_WEBHOOK_SECRET },
        body: JSON.stringify({ events: [event] }), signal: AbortSignal.timeout(10000),
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      deliveryFailed = true;
      log('[N8N_LOG_DELIVERY_ERROR] Event delivery failed');
    }
  }
  function diagnostic(data) {
    const delivery = emit(data);
    pending.add(delivery);
    delivery.finally(() => pending.delete(delivery));
  }
  await emit({ event: 'AUTOMATION_STARTED', message: 'Passport monitoring started', details: { dry_run: dryRun } });
  try {
    const launch = options.launch || (launchOptions => require('playwright').chromium.launch(launchOptions));
    browser = await launch({ headless: env.PASSPORT_HEADLESS !== '0', timeout: config.timeoutMs });
    const page = await browser.newPage();
    page.on('response', response => {
      if (response.status() >= 400) diagnostic({
        level: 'WARN', event: 'HTTP_ERROR_RESPONSE', message: `HTTP ${response.status()}`,
        http_status: response.status(), http_method: response.request().method(),
        resource_type: response.request().resourceType(), url: safeUrl(response.url()),
      });
    });
    page.on('requestfailed', request => diagnostic({
      level: 'WARN', event: 'HTTP_REQUEST_FAILED', message: 'Browser request failed',
      http_method: request.method(), resource_type: request.resourceType(), url: safeUrl(request.url()),
    }));
    page.on('pageerror', () => diagnostic({
      level: 'WARN', event: 'PAGE_JAVASCRIPT_ERROR', message: 'Page JavaScript error',
    }));
    result = await checkAvailability(page, config);
  } catch (error) {
    result = outcome(RESULT.CHECK_FAILED, {
      center: CENTER, service: config.service || null, slots: [], reason: error.name,
    });
  } finally {
    try { await browser?.close(); } catch { /* The availability result is already recorded. */ }
  }
  // One final result per run, including launch/navigation/availability failures.
  await emit({
    event: 'CHECK_RESULT', level: result.result === RESULT.CHECK_FAILED ? 'WARN' : 'INFO',
    result: result.result, message: result.message, details: result.details,
    http_status: result.httpStatus, http_method: 'GET', resource_type: 'document', url: QUEUE_URL,
  });
  await emit({ event: 'AUTOMATION_FINISHED', message: 'Passport monitoring finished' });
  await Promise.allSettled([...pending]);
  return { ...result, deliveryFailed };
}

module.exports = { RESULT, checkAvailability, formatResult, run };
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
  run({ dryRun: process.argv.includes('--dry-run') || process.env.PASSPORT_DRY_RUN === '1' })
    .then(result => { if (result.result === RESULT.CHECK_FAILED || result.deliveryFailed) process.exitCode = 1; })
    .catch(() => { console.error('Не вдалося перевірити доступність'); process.exitCode = 1; });
}
