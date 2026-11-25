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
  lastOdooAuthTime: 0
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

async function lookupInOdoo(number) {
  const config = await getConfig();
  const clean = number.replace(/[^0-9]/g, '');
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

async function authenticateOdoo(config) {
  const baseUrl = config.odooUrl.replace(/\/+$/, '');

  // Use cached auth if less than 5 minutes old
  if (state.lastOdooAuth && (Date.now() - state.lastOdooAuthTime < 300000)) {
    console.log('[Odoo Auth] Using cached session');
    return state.lastOdooAuth;
  }

  const password = config.odooApiKey || config.odooPassword || '';
  const login = config.odooUsername || 'admin';
  const db = config.odooDb;

  console.log('[Odoo Auth] Authenticating to', baseUrl);
  const res = await fetch(`${baseUrl}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    redirect: 'follow',
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: { db, login, password }
    })
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    console.log('[Odoo Auth] Failed to parse response:', text.substring(0, 100));
    return null;
  }
  if (!data.result?.uid) {
    console.log('[Odoo Auth] Auth failed, no uid in response');
    return null;
  }
  console.log('[Odoo Auth] Authenticated as uid:', data.result.uid);
  state.lastOdooAuth = { uid: data.result.uid, db, login };
  state.lastOdooAuthTime = Date.now();
  return state.lastOdooAuth;
}

async function odooSearch(config, session, model, domain, fields, limit, order) {
  const baseUrl = config.odooUrl.replace(/\/+$/, '');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${baseUrl}/web/dataset/call_kw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call',
        params: {
          model: model,
          method: 'search_read',
          args: [domain],
          kwargs: order ? { fields, limit, order } : { fields, limit }
        }
      })
    });
    clearTimeout(timeout);

    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) console.log('[Odoo Search] Error response:', model, parsed.error.message);
      else console.log('[Odoo Search] Results count:', model, parsed.result?.length || 0);
      return parsed;
    } catch (e) {
      console.log('[Odoo Search] Parse error:', model, text.substring(0, 100));
      return { error: { message: text.substring(0, 200) } };
    }
  } catch (e) {
    clearTimeout(timeout);
    console.error('[Odoo Search] Fetch error:', model, e.message);
    return { error: { message: e.message } };
  }
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

async function lookupViaJsonRpc(config, cleanNumber) {
  try {
    const session = await authenticateOdoo(config);
    if (!session) {
      console.log('[Odoo Lookup] Auth failed');
      return [];
    }

    const fields = ['id', 'name', 'phone', 'mobile', 'email', 'company_name', 'street', 'street2', 'city', 'state_id', 'country_id', 'category_id', 'function', 'website'];

    // Generate grouped LIKE patterns to handle formatted numbers like "+51 994 390 407"
    // Each group of digits separated by % matches any characters (spaces, dashes, etc.)
    // This is more precise than putting % between EVERY digit (which allows other digits to appear)
    const groupedPatterns = buildGroupedPatterns(cleanNumber);
    console.log('[Odoo Lookup] Trying', groupedPatterns.length, 'patterns');

    for (const pattern of groupedPatterns) {
      console.log('[Odoo Lookup] LIKE pattern:', pattern);
      const data = await odooSearch(config, session, 'res.partner',
        ['|', ['phone', '=like', pattern], ['mobile', '=like', pattern]],
        fields, 10
      );
      if (data.result?.length > 0) {
        const isSuffix = pattern.startsWith('%') && !pattern.endsWith('%') && pattern.slice(1).indexOf('%') === -1;
        const searchSuffix = isSuffix ? pattern.slice(1) : '';
        for (const rec of data.result) {
          const rawPhone = (rec.phone || rec.mobile || '').replace(/[^0-9]/g, '');
          if (isSuffix && !rawPhone.endsWith(searchSuffix)) {
            rec._skip = true;
            continue;
          }
          rec._matchDiff = Math.abs(rawPhone.length - cleanNumber.length);
          rec._endsWithSearch = rawPhone.endsWith(cleanNumber);
          rec._includesSearch = rawPhone.includes(cleanNumber);
        }
        const valid = data.result.filter(r => !r._skip).sort((a, b) => {
          if (a._matchDiff !== b._matchDiff) return a._matchDiff - b._matchDiff;
          if (a._endsWithSearch !== b._endsWithSearch) return a._endsWithSearch ? -1 : 1;
          if (a._includesSearch !== b._includesSearch) return a._includesSearch ? -1 : 1;
          return 0;
        });
        let maxDiff = isSuffix ? 2 : 1;
        if (valid.length > 0) {
          if (valid[0]._endsWithSearch) maxDiff = 4;
          else if (valid[0]._includesSearch) maxDiff = 5;
        }
        if (valid.length > 0 && valid[0]._matchDiff <= maxDiff) {
          console.log('[Odoo Lookup] Found with pattern:', pattern, valid.length, 'matches, best diff:', valid[0]._matchDiff, 'endsWithSearch:', valid[0]._endsWithSearch, 'includesSearch:', valid[0]._includesSearch);
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
        console.log('[Odoo Lookup] Pattern matched but no good match, trying next');
      }
    }

    console.log('[Odoo Lookup] No matches found');
  } catch (e) { console.error('[Odoo Lookup] Error:', e); }
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
    case 'updateConfig': (async () => { await saveConfig(msg.config); sendResponse({ success: true }); })(); return true;
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

chrome.runtime.onStartup.addListener(() => { state.callState = CALL_STATE.IDLE; updateBadge(); });
updateBadge();
