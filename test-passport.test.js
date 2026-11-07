const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { checkAvailability, run, RESULT } = require('./test-passport');

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const fixture = `<!doctype html><title>Електронна черга</title>
<form>
  <label for="service">Послуга *</label><select id="service">
    <option value="0">Оберіть послугу</option>
    <option value="passport">Оформлення паспорта</option><option value="other">Інша послуга</option>
  </select>
  <label for="day">Обрати день *</label><select id="day" disabled><option value="">Обрати день</option></select>
  <label for="time">Обрати час *</label><select id="time" disabled><option value="">Обрати час</option></select>
  <div role="alert" id="notice"></div>
  <label>Прізвище<input id="last_name"></label><button>Продовжити</button>
</form>
<script>
  window.personalDataTouched = false;
  document.querySelector('input').addEventListener('input', () => { window.personalDataTouched = true; });
  document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.personalDataTouched = true; });
  const service = document.querySelector('#service'), day = document.querySelector('#day'), time = document.querySelector('#time');
  service.addEventListener('change', async () => {
    const response = await fetch('/days');
    const data = await response.json();
    if (data.notice) document.querySelector('#notice').textContent = data.notice;
    if (data.html !== undefined) day.innerHTML = data.html;
    day.disabled = Boolean(data.disabled);
  });
  day.addEventListener('change', async () => {
    // Deliberately keep old times visible until the new request completes.
    const response = await fetch('/times?day=' + day.value);
    const data = await response.json();
    time.innerHTML = data.html;
    time.disabled = Boolean(data.disabled);
  });
</script>`;

const dates = '<option value="0">Оберіть день</option><option value="2026-11-09">09.11.2026</option>' +
  '<option value="2026-11-10">10.11.2026</option><optgroup disabled><option value="unavailable">11.11.2026</option></optgroup>';
const empty = '<option value="">Наразі всі місця зайняті</option>';

async function prepare(page, settings = {}) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/days') {
      if (settings.abortDays) return route.abort();
      if (settings.dayDelay) await new Promise(resolve => setTimeout(resolve, settings.dayDelay));
      if (page.isClosed()) return;
      return route.fulfill({ status: settings.dayStatus || 200, json: settings.days || { html: dates } });
    }
    if (url.pathname === '/times') {
      const day = url.searchParams.get('day');
      if (day === '2026-11-10') await new Promise(resolve => setTimeout(resolve, 600));
      if (page.isClosed()) return;
      return route.fulfill({ status: settings.failSecond && day === '2026-11-10' ? 500 : 200,
        json: { html: settings.timeHtml ?? (settings.noTimes ? empty : day === '2026-11-09'
          ? '<option value="0">Оберіть час</option><option value="0900">09:00</option><option value="1000">10:00</option><option disabled value="1100">11:00</option>'
          : '<option value="1430">14:30</option>') } });
    }
    return route.fulfill({ status: settings.status || 200, contentType: 'text/html; charset=utf-8', body: settings.html || fixture });
  });
}

async function check(settings = {}, config = {}) {
  const page = await browser.newPage();
  try {
    await prepare(page, settings);
    const result = await checkAvailability(page, {
      url: 'https://queue.test/e-queue', service: 'passport', center: 'Тестовий центр',
      timeoutMs: 1400, totalTimeoutMs: 7000, ...config,
    });
    if (!page.isClosed() && await page.locator('#last_name').count()) {
      assert.equal(await page.locator('#last_name').inputValue(), '');
      assert.equal(await page.evaluate(() => window.personalDataTouched), false);
    }
    return result;
  } finally { await page.close(); }
}

test('collects real dates/times, excludes placeholders and disabled options, waits for date refresh', async () => {
  const result = await check();
  assert.equal(result.result, RESULT.SLOTS_FOUND, JSON.stringify(result));
  assert.deepEqual(result.details.slots.map(slot => [slot.date, slot.time]), [
    ['09.11.2026', '09:00'], ['09.11.2026', '10:00'], ['10.11.2026', '14:30'],
  ]);
  assert.match(result.message, /^Знайдено місце: Тестовий центр, Оформлення паспорта, 09\.11\.2026, 09:00/);
});

test('does not reuse old times when a placeholder changes before the next request even starts', async () => {
  const delayedRequestFixture = fixture.replace(
    "const response = await fetch('/times?day=' + day.value);",
    `if (day.value === '2026-11-10') {
      time.options[0].textContent = 'Оберіть час для нового дня';
      await new Promise(resolve => setTimeout(resolve, 650));
    }
    const response = await fetch('/times?day=' + day.value);`,
  );
  const result = await check({ html: delayedRequestFixture }, { timeoutMs: 2500, totalTimeoutMs: 9000 });
  assert.equal(result.result, RESULT.SLOTS_FOUND, JSON.stringify(result));
  assert.deepEqual(result.details.slots.map(slot => [slot.date, slot.time]), [
    ['09.11.2026', '09:00'], ['09.11.2026', '10:00'], ['10.11.2026', '14:30'],
  ]);
});

test('invalid dates and error labels cannot become available appointments', async () => {
  for (const [value, label] of [
    ['2026-02-30', '30.02.2026'],
    ['error', 'Calendar unavailable'],
    ['2026-11-09', 'Calendar unavailable'],
  ]) {
    const result = await check({ days: { html: `<option value="${value}">${label}</option>` } });
    assert.equal(result.result, RESULT.CHECK_FAILED, JSON.stringify({ value, label, result }));
    assert.equal(result.details.reason, 'UNRECOGNIZED_DATE');
    assert.deepEqual(result.details.slots, []);
  }
});

test('invalid clock times and error text containing a time cannot become available appointments', async () => {
  for (const text of ['99:99', '09:60', 'Error at 09:00']) {
    const result = await check({
      days: { html: '<option value="2026-11-09">09.11.2026</option>' },
      timeHtml: `<option value="invalid">${text}</option>`,
    });
    assert.equal(result.result, RESULT.CHECK_FAILED, JSON.stringify({ text, result }));
    assert.equal(result.details.reason, 'UNRECOGNIZED_TIME');
    assert.deepEqual(result.details.slots, []);
  }
});

test('supports exact service labels', async () => {
  assert.equal((await check({ days: { html: empty, disabled: true } }, { service: 'Оформлення паспорта' })).result, RESULT.NO_SLOTS);
});

test('confirmed empty dates produce the exact no-slots message', async () => {
  const result = await check({ days: { html: empty, disabled: true } });
  assert.equal(result.result, RESULT.NO_SLOTS, JSON.stringify(result));
  assert.equal(result.message, 'Вільних місць немає');
});

test('a newly displayed explicit empty response is recognized even without dropdown mutations', async () => {
  const result = await check({ days: { notice: 'Наразі всі місця зайняті', disabled: true } });
  assert.equal(result.result, RESULT.NO_SLOTS, JSON.stringify(result));
});

test('dates with explicitly unavailable times are not bookable slots', async () => {
  assert.equal((await check({ noTimes: true })).result, RESULT.NO_SLOTS);
});

test('empty or still-loading day controls fail instead of claiming no slots', async () => {
  for (const html of ['', '<option value="">Обрати день</option>', '<option value="">Завантаження...</option>']) {
    const result = await check({ days: { html } });
    assert.equal(result.result, RESULT.CHECK_FAILED);
    assert.equal(result.message, 'Не вдалося перевірити доступність');
  }
});

test('requires an explicit service when there are multiple choices', async () => {
  const result = await check({}, { service: '' });
  assert.equal(result.result, RESULT.CHECK_FAILED);
  assert.equal(result.details.reason, 'SERVICE_NOT_CONFIGURED');
  assert.equal(result.details.available_services.length, 2);
});

test('rejects an unknown service', async () => {
  assert.equal((await check({}, { service: 'missing' })).details.reason, 'SERVICE_NOT_FOUND');
});

test('HTTP blocks and failed pages always produce CHECK_FAILED', async () => {
  for (const status of [403, 429, 500]) assert.equal((await check({ status })).result, RESULT.CHECK_FAILED);
});

test('a Cloudflare challenge with HTTP 200 is an unsuccessful check', async () => {
  const result = await check({ html: '<title>Just a moment...</title><p>Verify you are human</p>' });
  assert.equal(result.result, RESULT.CHECK_FAILED);
  assert.equal(result.details.reason, 'CLOUDFLARE_BLOCKED');
});

test('a successful HTTP response without a queue form is an unsuccessful check', async () => {
  const result = await check({ html: '<title>Електронна черга</title><p>Service is temporarily unavailable.</p>' },
    { timeoutMs: 500 });
  assert.equal(result.result, RESULT.CHECK_FAILED);
  assert.equal(result.message, 'Не вдалося перевірити доступність');
  assert.deepEqual(result.details.slots, []);
});

test('a page JavaScript error prevents either successful availability outcome', async () => {
  const result = await check({
    html: fixture + '<script>throw new Error("Fixture availability script failed");</script>',
    days: { html: empty, disabled: true },
  });
  assert.equal(result.result, RESULT.CHECK_FAILED, JSON.stringify(result));
  assert.equal(result.details.reason, 'PAGE_JAVASCRIPT_ERROR');
  assert.equal(result.message, 'Не вдалося перевірити доступність');
  assert.deepEqual(result.details.slots, []);
});

test('availability API errors and aborted requests cannot become NO_SLOTS', async () => {
  assert.equal((await check({ dayStatus: 500 })).result, RESULT.CHECK_FAILED);
  assert.equal((await check({ abortDays: true })).result, RESULT.CHECK_FAILED);
});

test('an error after one date succeeds invalidates the incomplete report', async () => {
  const result = await check({ failSecond: true });
  assert.equal(result.result, RESULT.CHECK_FAILED);
  assert.deepEqual(result.details.slots, []);
});

test('total check deadline bounds waiting for availability', async () => {
  const started = Date.now();
  const result = await check({ dayDelay: 1500 }, { totalTimeoutMs: 650 });
  assert.equal(result.result, RESULT.CHECK_FAILED);
  assert.ok(Date.now() - started < 2000);
});

test('removing a control near the overall deadline cannot extend checking by the locator timeout', async () => {
  const removedControlFixture = fixture.replace(
    'day.disabled = Boolean(data.disabled);',
    'day.disabled = Boolean(data.disabled); setTimeout(() => day.remove(), 350);',
  );
  const started = Date.now();
  const result = await check({
    html: removedControlFixture,
    days: { html: '<option value="">Завантаження...</option>', disabled: true },
  }, { timeoutMs: 5000, totalTimeoutMs: 1000 });
  assert.equal(result.result, RESULT.CHECK_FAILED, JSON.stringify(result));
  assert.equal(result.details.reason, 'CHECK_TIMEOUT');
  assert.ok(Date.now() - started < 2200, 'The total deadline must interrupt a locator waiting for a removed element');
});

test('dry run sends no webhook, emits one final event, and closes its page', async () => {
  const logs = [];
  let sends = 0;
  let closed = false;
  const page = await browser.newPage();
  await prepare(page, { days: { html: empty, disabled: true } });
  const result = await run({
    env: { PASSPORT_SERVICE: 'passport', N8N_WEBHOOK_URL: 'https://never-send.invalid', N8N_WEBHOOK_SECRET: 'test-only' },
    dryRun: true, log: line => logs.push(JSON.parse(line)),
    fetchImpl: async () => { sends += 1; throw new Error('Unexpected external send'); },
    launch: async () => ({ newPage: async () => page, close: async () => { closed = true; await page.close(); } }),
  });
  assert.equal(result.result, RESULT.NO_SLOTS);
  assert.equal(sends, 0);
  assert.equal(closed, true);
  assert.equal(logs.filter(event => event.event === 'CHECK_RESULT').length, 1);
});

test('browser launch failure still sends one final result using the existing webhook contract', async () => {
  const requests = [];
  const result = await run({
    env: { N8N_WEBHOOK_URL: 'https://fake.invalid', N8N_WEBHOOK_SECRET: 'test-only', TENANT_ID: 'test', BOT_ID: 'bot' },
    log: () => {}, launch: async () => { throw new Error('Browser unavailable'); },
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  const events = requests.flatMap(request => request.body.events);
  assert.equal(result.result, RESULT.CHECK_FAILED);
  assert.equal(events.filter(event => event.event === 'CHECK_RESULT').length, 1);
  assert.equal(new Set(events.map(event => event.event_id)).size, events.length);
  assert.equal(new Set(events.map(event => event.run_id)).size, 1);
  assert.ok(requests.every(request => request.options.headers['x-monitor-key'] === 'test-only'));
  assert.ok(events.every(event => event.tenant_id === 'test' && event.bot_id === 'bot'));
});
