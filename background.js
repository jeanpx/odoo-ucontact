const STORAGE_KEYS = { CONFIG: 'ucontact_config', CALL_LOG: 'call_log' };
const CALL_STATE = { IDLE: 'idle', CALLING: 'calling', ON_CALL: 'on_call', RINGING: 'ringing' };

let state = {
  callState: CALL_STATE.IDLE,
  currentCallId: null,
  callStartTime: null,
  currentDestination: null,
  callerInfo: null,
  lastNumberLookup: null,
  lastLookupResult: null,
  lastLookupTime: 0,
  lastOdooAuth: null,
  lastOdooAuthTime: 0,
  partnerFields: null,
  lastAuthError: null
};

async function getConfig() {
  const r = await chrome.storage.sync.get(STORAGE_KEYS.CONFIG);
  return r[STORAGE_KEYS.CONFIG] || {};
}

async function saveConfig(config) {
  await chrome.storage.sync.set({ [STORAGE_KEYS.CONFIG]: config });
}

async function getCallLog() {
  const r = await chrome.storage.local.get(STORAGE_KEYS.CALL_LOG);
  return r[STORAGE_KEYS.CALL_LOG] || [];
}

async function addCallLogEntry(entry) {
  const log = await getCallLog();
  log.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (log.length > 100) log.length = 100;
  await chrome.storage.local.set({ [STORAGE_KEYS.CALL_LOG]: log });
}

function getAuthHeaders(config) {
  if (config.authMethod === 'token' && config.apiToken)
    return { 'Authorization': `Bearer ${config.apiToken}` };
  return {};
}

async function apiRequest(config, endpoint, params) {
  const base = config.instance
    ? `https://${config.instance}/Integra/resources`
    : `${config.customUrl}/Integra/resources`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    ...getAuthHeaders(config)
  };
  if (config.authMethod === 'credentials' && config.sessionToken)
    headers['Authorization'] = `Basic ${btoa(`${config.username}:${config.sessionToken}`)}`;
  const body = params ? new URLSearchParams(params).toString() : '';
  const res = await fetch(`${base}${endpoint}`, { method: 'POST', headers, body });
  return res.text();
}

async function authenticate(config) {
  if (config.authMethod === 'token' && config.apiToken)
    return { success: true };
  if (config.authMethod === 'credentials' && config.username && config.password) {
    try {
      const r = await apiRequest(config, '/auth/getUserToken', { user: config.username, password: config.password });
      if (r && r !== '0') { config.sessionToken = r.trim(); await saveConfig(config); return { success: true }; }
      return { success: false, error: 'Credenciales inválidas' };
    } catch (e) { return { success: false, error: e.message }; }
  }
  return { success: false, error: 'Configuración incompleta' };
}

async function makeCall(destination) {
  const config = await getConfig();
  if (!config.instance && !config.customUrl) return { success: false, error: 'Servidor no configurado' };
  const auth = await authenticate(config);
  if (!auth.success) return auth;
  try {
    const params = {
      callerid: config.callerId || config.agentPhone || '',
      agent: config.agentName || '',
      phone: config.agentPhone || '',
      tech: config.tech || 'SIP',
      context: config.context || '',
      outqueue: config.outqueue || '',
      destination
    };
    const result = await apiRequest(config, '/Agents/AgentCall', params);
    if (result && result !== '0') {
      state.callState = CALL_STATE.CALLING;
      state.currentCallId = result.trim();
      state.currentDestination = destination;
      state.callStartTime = Date.now();
      await addCallLogEntry({ type: 'outbound', direction: 'outbound', number: destination, status: 'initiated', callId: state.currentCallId });
      updateBadge();
      broadcast({ type: 'callState', state: state.callState, destination, callId: state.currentCallId });
      setTimeout(() => { if (state.callState === CALL_STATE.CALLING) { state.callState = CALL_STATE.ON_CALL; updateBadge(); broadcast({ type: 'callState', state: state.callState }); } }, 5000);
      return { success: true, callId: result.trim() };
    }
    return { success: false, error: 'No se obtuvo ID de llamada' };
  } catch (err) { state.callState = CALL_STATE.IDLE; updateBadge(); return { success: false, error: err.message }; }
}

async function hangUp() {
  const config = await getConfig();
  if (state.currentCallId) {
    try { await apiRequest(config, '/Agents/HangupPhone', { callId: state.currentCallId }); } catch (e) {}
    const duration = state.callStartTime ? Math.round((Date.now() - state.callStartTime) / 1000) : 0;
    await addCallLogEntry({ type: 'outbound', direction: 'outbound', number: state.currentDestination, status: 'completed', callId: state.currentCallId, duration });
  }
  state.callState = CALL_STATE.IDLE;
  state.currentCallId = null;
  state.currentDestination = null;
  state.callStartTime = null;
  updateBadge();
  broadcast({ type: 'callState', state: state.callState });
  return { success: true };
}

async function getStatus() {
  const config = await getConfig();
  return {
    connected: !!(config.instance || config.customUrl),
    callState: state.callState,
    currentCall: state.currentCallId ? { id: state.currentCallId, destination: state.currentDestination, startTime: state.callStartTime } : null,
    config: { instance: config.instance || config.customUrl || '', authMethod: config.authMethod || 'token' }
  };
}

// Quita el prefijo internacional de Perú con el que uContact entrega algunas llamadas:
// 01151919630893 / 00151919630893 / 0051919630893 / 51919630893 -> 919630893
// Tras el "51" quedan 9 dígitos (celular) u 8 (fijo con código de área).
function normalizePhone(number) {
  const digits = String(number || '').replace(/[^0-9]/g, '');
  const m = digits.match(/^(?:0+1*)?51(\d{8,9})$/);
  return m ? m[1] : digits;
}

async function lookupInOdoo(number) {
  const config = await getConfig();
  const clean = normalizePhone(number);
  console.log('[Odoo Lookup] Looking up number:', number, 'cleaned:', clean);
  if (clean.length < 7) {
    console.log('[Odoo Lookup] Number too short');
    return null;
  }

  if (state.lastNumberLookup === clean && state.lastLookupResult && (Date.now() - state.lastLookupTime < 60000)) {
    console.log('[Odoo Lookup] Using cached result');
    return state.lastLookupResult;
  }

  let records = null;

  if (config.odooUrl && config.odooDb) {
    console.log('[Odoo Lookup] Calling lookupViaJsonRpc');
    records = await lookupViaJsonRpc(config, clean);
  } else {
    console.log('[Odoo Lookup] Odoo not configured');
    return { error: 'Odoo no está configurado. Abre las opciones de la extensión.' };
  }

  if (records && records.error) {
    console.log('[Odoo Lookup] Error:', records.error);
    return records;
  }

  if (records && records.length > 0) {
    console.log('[Odoo Lookup] Found records:', records.length);
    state.lastNumberLookup = clean;
    state.lastLookupResult = records;
    state.lastLookupTime = Date.now();
    return records;
  }

  console.log('[Odoo Lookup] No records found');
  return null;
}

async function postJson(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: payload })
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) {
      return { error: { message: `Respuesta inválida de Odoo (HTTP ${res.status})` } };
    }
  } catch (e) {
    return { error: { message: e.name === 'AbortError' ? 'Odoo no respondió a tiempo' : e.message } };
  } finally {
    clearTimeout(timeout);
  }
}

function rpcError(data) {
  return data?.error ? (data.error.data?.message || data.error.message || 'Error desconocido') : null;
}

// Devuelve { uid, db, login, mode: 'apikey'|'session', key? } o null (motivo en state.lastAuthError)
async function authenticateOdoo(config, force) {
  const baseUrl = config.odooUrl.replace(/\/+$/, '');

  // Use cached auth if less than 5 minutes old
  if (!force && state.lastOdooAuth && (Date.now() - state.lastOdooAuthTime < 300000)) {
    console.log('[Odoo Auth] Using cached session');
    return state.lastOdooAuth;
  }

  const login = config.odooUsername || 'admin';
  const db = config.odooDb;
  const errors = [];
  let auth = null;

  // 1) API Key: solo es válida en la API externa (/jsonrpc), NO en el login web
  if (config.odooApiKey) {
    const data = await postJson(`${baseUrl}/jsonrpc`, { service: 'common', method: 'authenticate', args: [db, login, config.odooApiKey, {}] });
    if (data.result) auth = { uid: data.result, db, login, mode: 'apikey', key: config.odooApiKey };
    else errors.push(`API Key: ${rpcError(data) || 'usuario o API Key inválidos'}`);
  }

  // 2) Usuario y contraseña: login web
  if (!auth && config.odooPassword) {
    const data = await postJson(`${baseUrl}/web/session/authenticate`, { db, login, password: config.odooPassword });
    if (data.result?.uid) auth = { uid: data.result.uid, db, login, mode: 'session' };
    else errors.push(`Contraseña: ${rpcError(data) || 'usuario o contraseña inválidos'}`);
  }

  // 3) Sesión de Odoo ya abierta en este navegador
  if (!auth) {
    const data = await postJson(`${baseUrl}/web/session/get_session_info`, {});
    if (data.result?.uid) auth = { uid: data.result.uid, db: data.result.db || db, login: data.result.username || login, mode: 'session' };
    else errors.push('No hay una sesión de Odoo abierta en el navegador');
  }

  if (!auth) {
    state.lastAuthError = errors.join(' · ');
    console.log('[Odoo Auth] Failed:', state.lastAuthError);
    return null;
  }
  console.log('[Odoo Auth] Authenticated as uid:', auth.uid, 'mode:', auth.mode);
  state.lastAuthError = null;
  state.lastOdooAuth = auth;
  state.lastOdooAuthTime = Date.now();
  return auth;
}

async function odooCall(config, model, method, args, kwargs, retried) {
  const baseUrl = config.odooUrl.replace(/\/+$/, '');
  const auth = state.lastOdooAuth;

  const data = auth?.mode === 'apikey'
    ? await postJson(`${baseUrl}/jsonrpc`, { service: 'object', method: 'execute_kw', args: [auth.db, auth.uid, auth.key, model, method, args, kwargs || {}] })
    : await postJson(`${baseUrl}/web/dataset/call_kw`, { model, method, args, kwargs: kwargs || {} });

  const msg = rpcError(data);
  if (msg) {
    console.log('[Odoo Call] Error response:', model, method, msg);
    // La sesión del navegador pudo expirar o cambiar: re-autenticar una vez
    if (!retried && auth?.mode !== 'apikey' && /session/i.test(data.error.data?.name || '')) {
      if (await authenticateOdoo(config, true)) return odooCall(config, model, method, args, kwargs, true);
    }
    return { error: { message: msg } };
  }
  return data;
}

async function testOdooConnection(config) {
  if (!config.odooUrl || !config.odooDb) return { success: false, error: 'Completa URL y base de datos primero' };
  state.lastOdooAuth = null;
  state.partnerFields = null;
  const auth = await authenticateOdoo(config, true);
  if (!auth) return { success: false, error: state.lastAuthError || 'No se pudo iniciar sesión' };
  const data = await odooCall(config, 'res.partner', 'search_read', [[]], { fields: ['id'], limit: 1 });
  if (data.error) return { success: false, error: `Sesión OK, pero falló la búsqueda: ${data.error.message}` };
  // La prueba usa la config del formulario (quizá sin guardar): no dejarla en caché
  state.lastOdooAuth = null;
  state.partnerFields = null;
  const how = auth.mode === 'apikey' ? 'API Key' : 'sesión web';
  return { success: true, message: `Conexión exitosa (${how}, usuario ${auth.login})` };
}

async function odooSearch(config, session, model, domain, fields, limit, order) {
  const data = await odooCall(config, model, 'search_read', [domain], order ? { fields, limit, order } : { fields, limit });
  if (!data.error) console.log('[Odoo Search] Results count:', model, data.result?.length || 0);
  return data;
}

// Detecta qué campos existen en res.partner (p. ej. `mobile` ya no existe en versiones recientes de Odoo)
async function getPartnerFields(config) {
  if (state.partnerFields) return state.partnerFields;
  const data = await odooCall(config, 'res.partner', 'fields_get', [], { attributes: ['type'] });
  if (data.error) return { error: data.error.message };
  state.partnerFields = Object.keys(data.result || {});
  console.log('[Odoo Lookup] res.partner phone fields:', ['phone', 'mobile', 'phone_mobile_search'].filter(f => state.partnerFields.includes(f)));
  return state.partnerFields;
}

async function fetchSaleOrders(config, session, partnerId) {
  try {
    const data = await odooSearch(config, session, 'sale.order',
      [['partner_id', '=', partnerId]],
      ['name', 'date_order', 'amount_total', 'state', 'stage_id', 'currency_id', 'partner_shipping_id'], 10
    );
    if (data.result?.length > 0) return data.result;
  } catch (e) { console.error('[Odoo Orders] Error:', e); }
  return [];
}

async function fetchTasks(config, session, partnerId) {
  try {
    const data = await odooSearch(config, session, 'project.task',
      [['partner_id', '=', partnerId]],
      ['name', 'project_id', 'stage_id', 'user_ids', 'date_deadline', 'x_studio_partner_shipping_id'], 50
    );
    if (data.result?.length > 0) return data.result;
  } catch (e) { console.error('[Odoo Tasks] Error:', e); }
  return [];
}

async function fetchTickets(config, session, partnerId) {
  try {
    const data = await odooSearch(config, session, 'helpdesk.ticket',
      [['partner_id', '=', partnerId]],
      ['name', 'stage_id', 'team_id', 'priority', 'create_date', 'x_studio_partner_shipping_id'], 50
    );
    if (data.result?.length > 0) return data.result;
  } catch (e) { console.error('[Odoo Tickets] Error:', e); }
  return [];
}

async function fetchCustomTickets(config, session, partnerId) {
  try {
    const data = await odooSearch(config, session, 'x_detalle_de_ticket',
      [['x_studio_partner_id', '=', partnerId]],
      ['x_studio_helpdesk_id', 'x_name', 'x_studio_stage_id', 'x_studio_fecha_operacion', 'x_studio_partner_shipping_id'], 50
    );
    if (data.result?.length > 0) return data.result;
  } catch (e) { console.error('[Odoo Custom Tickets] Error:', e); }
  return [];
}

async function fetchDebt(config, session, partnerId) {
  try {
    const data = await odooSearch(config, session, 'account.move',
      [['partner_id', '=', partnerId], ['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['payment_state', 'not in', ['paid', 'reversed']], ['amount_residual', '>', 0]],
      ['name', 'amount_residual', 'amount_total', 'invoice_date', 'payment_state', 'x_studio_subscription_id'], 50
    );
    if (data.result?.length > 0) {
      const total = data.result.reduce((sum, inv) => {
        const residual = Number(inv.amount_residual || inv.amount_total || 0);
        console.log('[Odoo Debt] Invoice:', inv.name, 'state:', inv.payment_state, 'residual:', residual);
        return sum + residual;
      }, 0);
      console.log('[Odoo Debt] Found', data.result.length, 'invoices, total debt:', total);
      return { invoices: data.result, invoiceCount: data.result.length, totalDebt: total };
    }
    console.log('[Odoo Debt] No unpaid invoices found');
    return { invoices: [], invoiceCount: 0, totalDebt: 0 };
  } catch (e) { console.error('[Odoo Debt] Error:', e); }
  return { invoices: [], invoiceCount: 0, totalDebt: 0 };
}

async function fetchLastInvoices(config, session, partnerId) {
  try {
    const data = await odooSearch(config, session, 'account.move',
      [['partner_id', '=', partnerId], ['move_type', '=', 'out_invoice'], ['state', '=', 'posted']],
      ['name', 'invoice_date', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state', 'currency_id'], 5,
      'invoice_date desc, id desc'
    );
    if (data.result?.length > 0) return data.result;
  } catch (e) { console.error('[Odoo Last Invoices] Error:', e); }
  return [];
}

function orDomain(fields, op, value) {
  const leaves = fields.map(f => [f, op, value]);
  return [...Array(Math.max(0, leaves.length - 1)).fill('|'), ...leaves];
}

// Menor = mejor coincidencia; null = no coincide. Revisa TODOS los teléfonos del contacto.
function phoneMatchScore(rec, phoneFields, clean) {
  let best = null;
  for (const f of phoneFields) {
    const d = String(rec[f] || '').replace(/[^0-9]/g, '');
    if (d.length < 7) continue;
    let score = null;
    if (d === clean) score = 0;
    else if (d.endsWith(clean) || clean.endsWith(d)) score = Math.abs(d.length - clean.length);
    if (score !== null && score <= 4 && (best === null || score < best)) best = score;
  }
  return best;
}

async function lookupViaJsonRpc(config, cleanNumber) {
  try {
    const session = await authenticateOdoo(config);
    if (!session) {
      console.log('[Odoo Lookup] Auth failed');
      return { error: `No se pudo iniciar sesión en Odoo. ${state.lastAuthError || ''}`.trim() };
    }

    const available = await getPartnerFields(config);
    if (available.error) return { error: `Error al leer contactos de Odoo: ${available.error}` };

    const phoneFields = ['phone', 'mobile'].filter(f => available.includes(f));
    const wanted = ['id', 'name', 'phone', 'mobile', 'email', 'company_name', 'street', 'street2', 'city', 'state_id', 'country_id', 'category_id', 'function', 'website'];
    const fields = wanted.filter(f => available.includes(f));

    // Búsquedas en orden de preferencia
    const domains = [];
    if (available.includes('phone_mobile_search')) {
      // Campo de Odoo que ignora espacios, guiones y "+" (p. ej. "+51 917 669 478")
      domains.push([['phone_mobile_search', 'ilike', cleanNumber.slice(-9)]]);
    }
    if (phoneFields.length > 0) {
      for (const pattern of buildGroupedPatterns(cleanNumber)) {
        domains.push(orDomain(phoneFields, '=like', pattern));
      }
    }

    let lastError = null;
    for (const domain of domains) {
      console.log('[Odoo Lookup] Domain:', JSON.stringify(domain));
      const data = await odooSearch(config, session, 'res.partner', domain, fields, 20);
      if (data.error) { lastError = data.error.message; continue; }
      if (!data.result?.length) continue;

      const valid = data.result
        .map(r => ({ r, score: phoneMatchScore(r, phoneFields, cleanNumber) }))
        .filter(x => x.score !== null)
        .sort((a, b) => a.score - b.score)
        .map(x => x.r);
      if (valid.length === 0) {
        console.log('[Odoo Lookup] Results did not match closely, trying next');
        continue;
      }

      console.log('[Odoo Lookup] Found', valid.length, 'matches, best:', valid[0].name);
      const best = valid[0];
      const [orders, tasks, tickets, customTickets, debt, lastInvoices] = await Promise.all([
        fetchSaleOrders(config, session, best.id).catch(e => { console.error('[Odoo] Orders error:', e); return []; }),
        fetchTasks(config, session, best.id).catch(e => { console.error('[Odoo] Tasks error:', e); return []; }),
        fetchTickets(config, session, best.id).catch(e => { console.error('[Odoo] Tickets error:', e); return []; }),
        fetchCustomTickets(config, session, best.id).catch(e => { console.error('[Odoo] CustomTickets error:', e); return []; }),
        fetchDebt(config, session, best.id).catch(e => { console.error('[Odoo] Debt error:', e); return { invoiceCount: 0, totalDebt: 0 }; }),
        fetchLastInvoices(config, session, best.id).catch(e => { console.error('[Odoo] Last invoices error:', e); return []; })
      ]);
      best._saleOrders = orders || [];
      best._tasks = tasks || [];
      best._tickets = tickets || [];
      best._customTickets = customTickets || [];
      best._debt = debt || { invoiceCount: 0, totalDebt: 0 };
      best._lastInvoices = lastInvoices || [];
      return valid;
    }

    console.log('[Odoo Lookup] No matches found');
    // Si las búsquedas fallaron con error, no es "cliente no encontrado"
    if (lastError) return { error: `Error al buscar en Odoo: ${lastError}` };
  } catch (e) {
    console.error('[Odoo Lookup] Error:', e);
    return { error: `Error al buscar en Odoo: ${e.message}` };
  }
  return [];
}

function buildGroupedPatterns(digits) {
  const patterns = [];
  const n = digits.length;

  // 1) SUFFIX: numbers that END with these digits (most common for dialed numbers)
  patterns.push(`%${digits}`);

  // 2) Suffix with grouped wildcards (for formatted storage like "+51 994 340 7")
  if (n >= 6) {
    patterns.push(`%${digits.substring(0, 3)}%${digits.substring(3)}`);  // e.g. %994%3407
    patterns.push(`%${digits.substring(0, 4)}%${digits.substring(4)}`);  // e.g. %9943%407
  }

  // 3) Exact consecutive anywhere (fallback)
  patterns.push(`%${digits}%`);

  // 4) Grouped anywhere (fallback for formatted numbers)
  if (n >= 7) {
    patterns.push('%' + digits.substring(0, 3) + '%' + digits.substring(3, 6) + '%' + digits.substring(6) + '%');
    patterns.push('%' + digits.substring(0, 3) + '%' + digits.substring(3, 7) + '%' + digits.substring(7) + '%');
    patterns.push('%' + digits.substring(0, 4) + '%' + digits.substring(4, 7) + '%' + digits.substring(7) + '%');
  }
  if (n >= 8 && digits.length >= 10) {
    patterns.push('%' + digits.substring(0, 2) + '%' + digits.substring(2, 5) + '%' + digits.substring(5, 8) + '%' + digits.substring(8) + '%');
  }

  // Deduplicate while preserving order
  const seen = new Set();
  return patterns.filter(p => { if (seen.has(p)) return false; seen.add(p); return true; });
}

async function handleIncomingCall(number, extraData) {
  state.callState = CALL_STATE.RINGING;
  state.currentDestination = number;
  updateBadge();

  const contacts = await lookupInOdoo(number);
  const callerInfo = contacts && contacts.length > 0 ? contacts[0] : null;
  state.callerInfo = callerInfo;

  if (callerInfo) {
    await addCallLogEntry({ type: 'inbound', direction: 'inbound', number, status: 'ringing', contactName: callerInfo.name });
    broadcast({ type: 'incomingCallWithData', number, callerInfo });
    showPopupNotification(number, callerInfo);
  } else {
    await addCallLogEntry({ type: 'inbound', direction: 'inbound', number, status: 'ringing' });
    broadcast({ type: 'incomingCall', number, callerInfo: null });
    showPopupNotification(number, null);
  }
}

async function handleNumberTyped(number) {
  const contacts = await lookupInOdoo(number);
  if (contacts && contacts.length > 0) {
    broadcast({ type: 'numberLookupResult', number, contacts });
    return contacts;
  }
  broadcast({ type: 'numberLookupResult', number, contacts: [] });
  return [];
}

function formatAddress(c) {
  if (!c) return '';
  const name = (v) => Array.isArray(v) ? v[1] : (v || '');
  return [c.street, c.street2, c.city, name(c.state_id)].filter(Boolean).join(', ');
}

function showPopupNotification(number, callerInfo) {
  const name = callerInfo?.name || 'Número desconocido';
  const lines = [number];
  const address = formatAddress(callerInfo);
  if (address) lines.push(address);
  if (callerInfo?._debt) {
    const d = Number(callerInfo._debt.totalDebt || 0);
    lines.push(d > 0 ? `Deuda: S/ ${d.toFixed(2)} (${callerInfo._debt.invoiceCount} fact.)` : 'Sin deuda');
  }

  chrome.notifications.create('incoming-call', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `📞 Llamada entrante`,
    message: `${name}`,
    contextMessage: lines.join(' · '),
    priority: 2,
    buttons: [{ title: 'Abrir en Odoo' }, { title: 'Ignorar' }]
  }).catch(() => {});
}

chrome.notifications.onButtonClicked.addListener((id, idx) => {
  if (id === 'incoming-call' && idx === 0) {
    const config = chrome.storage.sync.get(STORAGE_KEYS.CONFIG, (cfg) => {
      const c = cfg[STORAGE_KEYS.CONFIG] || {};
      if (c.odooUrl && state.callerInfo?.id) {
        chrome.tabs.create({ url: `${c.odooUrl.replace(/\/+$/, '')}/web#id=${state.callerInfo.id}&model=res.partner&view_type=form` });
      }
    });
  }
  chrome.notifications.clear(id);
});

function updateBadge() {
  const map = { [CALL_STATE.IDLE]: '', [CALL_STATE.CALLING]: '...', [CALL_STATE.ON_CALL]: 'ACT', [CALL_STATE.RINGING]: 'RING' };
  const colors = { [CALL_STATE.IDLE]: '', [CALL_STATE.CALLING]: '#FF9800', [CALL_STATE.ON_CALL]: '#4CAF50', [CALL_STATE.RINGING]: '#F44336' };
  const t = map[state.callState] || '';
  if (t) { chrome.action.setBadgeText({ text: t }); chrome.action.setBadgeBackgroundColor({ color: colors[state.callState] }); }
  else chrome.action.setBadgeText({ text: '' });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'makeCall': makeCall(msg.destination).then(sendResponse); return true;
    case 'hangUp': hangUp().then(sendResponse); return true;
    case 'getStatus': getStatus().then(sendResponse); return true;
    case 'getCallLog': getCallLog().then(sendResponse); return true;
    case 'authenticate': (async () => { const c = await getConfig(); sendResponse(await authenticate(c)); })(); return true;
    case 'updateConfig': (async () => { await saveConfig(msg.config); state.lastOdooAuth = null; state.partnerFields = null; sendResponse({ success: true }); })(); return true;
    case 'testOdoo': (async () => { sendResponse(await testOdooConnection(msg.config)); })(); return true;
    case 'getConfig': (async () => { sendResponse(await getConfig()); })(); return true;
    case 'lookupInOdoo': (async () => { sendResponse(await lookupInOdoo(msg.number)); })(); return true;
    case 'handleNumberTyped': (async () => { sendResponse(await handleNumberTyped(msg.number)); })(); return true;
    case 'handleIncomingCall': (async () => { await handleIncomingCall(msg.number, msg.extraData); sendResponse({ success: true }); })(); return true;
    case 'callState': sendResponse(state); return true;
    case 'openInOdoo': openInOdoo(msg.model, msg.id, msg.viewType); return true;
  }
});

async function openInOdoo(model, id, viewType) {
  const config = await getConfig();
  if (config.odooUrl && id) {
    chrome.tabs.create({ url: `${config.odooUrl.replace(/\/+$/, '')}/web#id=${id}&model=${model || 'res.partner'}&view_type=${viewType || 'form'}` });
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEYS.CONFIG]) { state.lastOdooAuth = null; state.partnerFields = null; state.lastLookupResult = null; }
});

chrome.runtime.onStartup.addListener(() => { state.callState = CALL_STATE.IDLE; updateBadge(); });
updateBadge();
