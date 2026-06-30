const CONFIG_KEY = 'ucontact_config';

async function loadConfig() {
  try {
    const r = await chrome.storage.sync.get(CONFIG_KEY);
    return r[CONFIG_KEY] || {};
  } catch (e) {
    console.error('Error loading config:', e);
    return {};
  }
}

async function saveConfig(config) {
  await chrome.storage.sync.set({ [CONFIG_KEY]: config });
  try {
    await chrome.runtime.sendMessage({ action: 'updateConfig', config });
  } catch (e) {
    // background not ready yet, config saved locally
  }
}

function populateForm(config) {
  const fields = ['instance','customUrl','authMethod','apiToken','username','password',
    'agentName','agentPhone','callerId','tech','context','outqueue',
    'odooUrl','odooDb','odooUsername','odooPassword','odooApiKey',
    'notificationsEnabled','autoOpenPopup','popupDuration'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = config[id] !== undefined ? config[id] : (id === 'notificationsEnabled' || id === 'autoOpenPopup');
    else if (el.type === 'number') el.value = config[id] || '';
    else el.value = config[id] || '';
  });
  toggleAuthFields();
}

function readForm() {
  const get = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  const checked = id => { const e = document.getElementById(id); return e ? e.checked : false; };
  return {
    instance: get('instance'), customUrl: get('customUrl'),
    authMethod: get('authMethod'), apiToken: get('apiToken'),
    username: get('username'), password: get('password'),
    agentName: get('agentName'), agentPhone: get('agentPhone'),
    callerId: get('callerId'), tech: get('tech'),
    context: get('context'), outqueue: get('outqueue'),
    odooUrl: get('odooUrl'), odooDb: get('odooDb'),
    odooUsername: get('odooUsername'), odooPassword: get('odooPassword'),
    odooApiKey: get('odooApiKey'),
    notificationsEnabled: checked('notificationsEnabled'),
    autoOpenPopup: checked('autoOpenPopup'),
    popupDuration: parseInt(get('popupDuration')) || 30
  };
}

function toggleVisibility(id) {
  const el = document.getElementById(id);
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
}

function toggleAuthFields() {
  const m = document.getElementById('authMethod');
  if (!m) return;
  const v = m.value;
  const tf = document.getElementById('tokenFields');
  const cf = document.getElementById('credentialsFields');
  if (tf) tf.style.display = v === 'token' ? 'block' : 'none';
  if (cf) cf.style.display = v === 'credentials' ? 'block' : 'none';
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  const tabBtn = document.querySelector(`.tab[data-tab="${name}"]`);
  const tabContent = document.getElementById(`tab-${name}`);
  if (tabBtn) tabBtn.classList.add('active');
  if (tabContent) tabContent.classList.add('active');
}

async function resetConfig() {
  if (!confirm('¿Restablecer toda la configuración?')) return;
  await saveConfig({});
  populateForm({});
  showToast('Configuración restablecida');
}

function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:14px 24px;border-radius:10px;background:#1a1a1a;color:white;font-size:14px;font-weight:500;box-shadow:0 4px 20px rgba(0,0,0,0.2);z-index:9999;opacity:0;transform:translateY(10px);transition:opacity 0.3s,transform 0.3s';
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(10px)'; setTimeout(() => t.remove(), 300); }, 2500);
}

document.addEventListener('DOMContentLoaded', () => {
  loadConfig().then(config => {
    populateForm(config);

    document.getElementById('tabHeaders')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (btn) switchTab(btn.dataset.tab);
    });

    document.getElementById('btnReset')?.addEventListener('click', resetConfig);
    document.getElementById('authMethod')?.addEventListener('change', toggleAuthFields);
    document.getElementById('configForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = readForm();
      Object.keys(data).forEach(k => { if (data[k] === '' || data[k] === null || data[k] === undefined) delete data[k]; });
      await saveConfig(data);
      showToast('Configuración guardada ✓');
    });

    document.getElementById('btnTestOdoo')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnTestOdoo');
      const result = document.getElementById('odooTestResult');
      if (!btn || !result) return;
      btn.disabled = true;
      btn.textContent = 'Probando...';
      result.textContent = '';
      result.className = 'test-result';

      const cfg = readForm();
      if (!cfg.odooUrl || !cfg.odooDb) {
        result.textContent = '✗ Completa URL y base de datos primero';
        result.className = 'test-result error';
        btn.disabled = false;
        btn.textContent = 'Probar conexión a Odoo';
        return;
      }

      try {
        const baseUrl = cfg.odooUrl.replace(/\/+$/, '');
        const password = cfg.odooApiKey || cfg.odooPassword || '';

        const authRes = await fetch(`${baseUrl}/web/session/authenticate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          redirect: 'follow',
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call',
            params: { db: cfg.odooDb, login: cfg.odooUsername || 'admin', password }
          })
        });

        const authText = await authRes.text();
        let authData;
        try { authData = JSON.parse(authText); } catch (e) {
          result.textContent = `✗ El servidor no responde como Odoo. Inicio: ${authText.substring(0, 80)}`;
          result.className = 'test-result error';
          btn.disabled = false;
          btn.textContent = 'Probar conexión a Odoo';
          return;
        }

        if (authData.error) {
          const msg = authData.error.data?.message || authData.error.message || 'Error de autenticación';
          result.textContent = `✗ ${msg}`;
          result.className = 'test-result error';
          btn.disabled = false;
          btn.textContent = 'Probar conexión a Odoo';
          return;
        }

        if (!authData.result?.uid) {
          result.textContent = '✗ Credenciales inválidas';
          result.className = 'test-result error';
          btn.disabled = false;
          btn.textContent = 'Probar conexión a Odoo';
          return;
        }

        const searchRes = await fetch(`${baseUrl}/web/dataset/call_kw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          redirect: 'follow',
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call',
            params: {
              model: 'res.partner',
              method: 'search_read',
              args: [[]],
              kwargs: { fields: ['id'], limit: 1 }
            }
          })
        });
        const searchText = await searchRes.text();
        let searchData;
        try { searchData = JSON.parse(searchText); } catch (e) {
          result.textContent = `✗ Búsqueda falló: ${searchText.substring(0, 100)}`;
          result.className = 'test-result error';
          btn.disabled = false;
          btn.textContent = 'Probar conexión a Odoo';
          return;
        }

        if (searchData.result) {
          result.textContent = '✓ Conexión exitosa a Odoo';
          result.className = 'test-result success';
        } else {
          result.textContent = `✗ ${searchData.error?.data?.message || 'Error en búsqueda'}`;
          result.className = 'test-result error';
        }
      } catch (err) {
        result.textContent = `✗ ${err.message}`;
        result.className = 'test-result error';
      }
      btn.disabled = false;
      btn.textContent = 'Probar conexión a Odoo';
    });

    const vEl = document.getElementById('extVersion');
    if (vEl) vEl.textContent = chrome.runtime.getManifest().version;

    chrome.runtime.sendMessage({ action: 'getStatus' }).then(status => {
      const el = document.getElementById('extStatus');
      if (el) {
        if (status?.connected) { el.textContent = 'Conectado'; el.className = 'badge badge-success'; }
        else { el.textContent = 'Configuración pendiente'; el.className = 'badge badge-pending'; }
      }
    }).catch(() => {
      const el = document.getElementById('extStatus');
      if (el) { el.textContent = 'Error'; el.className = 'badge badge-error'; }
    });
  }).catch(e => {
    console.error('Options init error:', e);
    showToast('Error al cargar configuración');
  });
});
