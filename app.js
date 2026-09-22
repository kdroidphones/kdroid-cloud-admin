const $ = selector => document.querySelector(selector);
const cfg = window.KDROID_CONFIG;
let token = sessionStorage.getItem('kdroid_token') || '';
let deviceRows = [];
let appRows = [];

function notice(message, error = false) {
  const element = $('#notice');
  element.textContent = message;
  element.className = 'show' + (error ? ' error' : '');
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => element.className = '', 4000);
}

async function request(path, options = {}) {
  const headers = { apikey: cfg.publishableKey, 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(cfg.supabaseUrl + path, { ...options, headers });
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body?.message || body?.error_description || `Request failed (${response.status})`);
  return body;
}

function switchView(name) {
  const phones = name === 'phones';
  $('#phone-view').classList.toggle('hidden', !phones);
  $('#apps-view').classList.toggle('hidden', phones);
  $('#show-phones').classList.toggle('active', phones);
  $('#show-apps').classList.toggle('active', !phones);
  $('#show-phones').setAttribute('aria-pressed', String(phones));
  $('#show-apps').setAttribute('aria-pressed', String(!phones));
  if (!phones) $('#app-search').focus();
  else if (token) $('#phone-search').focus();
}

async function login(event) {
  event.preventDefault();
  try {
    const body = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: $('#email').value, password: $('#password').value }) });
    token = body.access_token;
    sessionStorage.setItem('kdroid_token', token);
    showDashboard();
    notice('Signed in');
  } catch (error) { notice(error.message, true); }
}

function check(text, value, disabled = false) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  label.className = 'check'; input.type = 'checkbox'; input.checked = value; input.disabled = disabled;
  label.append(input, document.createTextNode(text));
  return { label, input };
}

function renderDevice(device) {
  const card = document.createElement('article'); card.className = 'device';
  const heading = document.createElement('h3'); heading.textContent = device.name || 'KDroid phone';
  const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${device.model || 'Unknown model'} | ${device.public_id}`;
  const seen = document.createElement('small'); seen.textContent = `Last connected: ${device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : 'Never'} | OS ${device.os_version || 'unknown'} | Store ${device.store_version || 'unknown'}`;
  const controls = document.createElement('div'); controls.className = 'controls';
  const basic = check('Basic', true, true), shopping = check('Shopping', !!device.shopping_enabled), business = check('Business', !!device.business_enabled), save = document.createElement('button');
  save.textContent = 'Save access'; controls.append(basic.label, shopping.label, business.label, save);
  save.onclick = async () => { try { await request(`/rest/v1/kdroid_devices?id=eq.${device.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ basic_enabled: true, shopping_enabled: shopping.input.checked, business_enabled: business.input.checked }) }); await command(device.id, 'sync_catalog'); notice(`${heading.textContent} will sync`); } catch (error) { notice(error.message, true); } };
  const form = document.createElement('form'), packageInput = document.createElement('input'), send = document.createElement('button');
  form.className = 'command'; packageInput.placeholder = 'App package, e.g. com.example.app'; packageInput.required = true; send.textContent = 'Send update'; form.append(packageInput, send);
  form.onsubmit = async event => { event.preventDefault(); try { await command(device.id, 'update_app', packageInput.value.trim()); packageInput.value = ''; notice(`Update queued for ${heading.textContent}`); } catch (error) { notice(error.message, true); } };
  card.append(heading, meta, seen, controls, form);
  return card;
}

function filterDevices() {
  const query = $('#phone-search').value.trim().toLowerCase();
  const matches = deviceRows.filter(device => [device.name, device.model, device.public_id, device.os_version, device.store_version].some(value => String(value || '').toLowerCase().includes(query)));
  const box = $('#devices'); box.replaceChildren();
  $('#phone-count').textContent = `${matches.length} of ${deviceRows.length} phones`;
  if (!matches.length) { box.innerHTML = '<p class="empty">No matching phones.</p>'; return; }
  matches.forEach(device => box.append(renderDevice(device)));
}

async function loadPhones() {
  const box = $('#devices'); box.textContent = 'Loading phones...';
  try { deviceRows = await request('/rest/v1/kdroid_devices?select=*&order=enrolled_at.desc'); filterDevices(); }
  catch (error) { if (/jwt|permission|401/i.test(error.message)) signout(); else { box.textContent = ''; notice(error.message, true); } }
}

function renderApp(app) {
  const card = document.createElement('article'); card.className = 'app';
  const icon = document.createElement('img'); icon.src = app.iconUrl || ''; icon.alt = ''; icon.loading = 'lazy';
  const body = document.createElement('div'), name = document.createElement('h3'), meta = document.createElement('small'), pkg = document.createElement('code');
  name.textContent = app.name; meta.textContent = `${app.versionName} | ${app.store} | ${app.category}`; pkg.textContent = app.packageName;
  body.append(name, meta, pkg); card.append(icon, body); return card;
}

function filterApps() {
  const query = $('#app-search').value.trim().toLowerCase();
  const matches = appRows.filter(app => [app.name, app.packageName, app.category, app.store, app.versionName].some(value => String(value || '').toLowerCase().includes(query)));
  const box = $('#apps'); box.replaceChildren(); $('#app-count').textContent = `${matches.length} of ${appRows.length} apps`;
  if (!matches.length) { box.innerHTML = '<p class="empty">No matching apps.</p>'; return; }
  matches.forEach(app => box.append(renderApp(app)));
}

async function loadApps() {
  const box = $('#apps');
  try { const response = await fetch('/catalog/v1/catalog.json', { cache: 'no-store' }); if (!response.ok) throw new Error('Catalog unavailable'); const catalog = await response.json(); appRows = catalog.apps.filter(app => !app.hidden); filterApps(); }
  catch (error) { $('#app-count').textContent = 'Unavailable'; box.textContent = error.message; }
}

async function command(id, type, packageName = null) {
  const row = { device_id: id, command_type: type, payload: {} }; if (packageName) row.package_name = packageName;
  await request('/rest/v1/kdroid_commands', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
}

function showDashboard() { $('#auth').classList.add('hidden'); $('#dashboard').classList.remove('hidden'); $('#logout').classList.remove('hidden'); loadPhones(); }
function signout() { token = ''; sessionStorage.removeItem('kdroid_token'); deviceRows = []; $('#auth').classList.remove('hidden'); $('#dashboard').classList.add('hidden'); $('#logout').classList.add('hidden'); }

$('#login').addEventListener('submit', login);
$('#logout').onclick = signout;
$('#refresh').onclick = loadPhones;
$('#show-phones').onclick = () => switchView('phones');
$('#show-apps').onclick = () => switchView('apps');
$('#phone-search').addEventListener('input', filterDevices);
$('#app-search').addEventListener('input', filterApps);
loadApps();
if (token) showDashboard();