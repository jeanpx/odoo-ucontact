let currentState = 'idle';
let currentNumber = '';

document.addEventListener('DOMContentLoaded', () => {
  const phoneInput = document.getElementById('phoneInput');
  const btnCall = document.getElementById('btnCall');
  const btnHangup = document.getElementById('btnHangup');
  const btnCallText = document.getElementById('btnCallText');
  const callStatus = document.getElementById('callStatus');
  const callStatusText = document.getElementById('callStatusText');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
      document.getElementById(`tab-${tab.dataset.tab}`).style.display = 'block';
      if (tab.dataset.tab === 'dial') refreshStatus();
      if (tab.dataset.tab === 'log') loadCallLog();
      if (tab.dataset.tab === 'settings') loadSettingsSummary();
    });
  });

  document.querySelectorAll('.key').forEach(key => {
    key.addEventListener('click', () => {
      const val = key.dataset.value;
      if (val === 'backspace') phoneInput.value = phoneInput.value.slice(0, -1);
      else phoneInput.value += val;
      phoneInput.focus();
      updateCallBtn();
    });
  });

  phoneInput.addEventListener('input', () => { updateCallBtn(); lookupNumber(); });
  phoneInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && phoneInput.value.trim()) callNumber(phoneInput.value.trim()); });

  btnCall.addEventListener('click', () => { if (currentNumber) callNumber(currentNumber); });
  btnHangup.addEventListener('click', hangUp);

  document.getElementById('btnClear').addEventListener('click', () => { phoneInput.value = ''; updateCallBtn(); hideCustomerPreview(); });
  document.getElementById('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  document.getElementById('btnTestConnection').addEventListener('click', testConnection);

  function updateCallBtn() {
    currentNumber = phoneInput.value.trim();
    if (currentNumber && currentState === 'idle') { btnCall.style.display = 'flex'; btnHangup.style.display = 'none'; }
    else if (currentState === 'on_call' || currentState === 'calling') { btnCall.style.display = 'none'; btnHangup.style.display = 'flex'; }
    else { btnCall.style.display = 'none'; btnHangup.style.display = 'none'; }
  }

  let lookupTimer = null;
  function lookupNumber() {
    const val = phoneInput.value.trim();
    const digits = val.replace(/[^0-9]/g, '');
    if (digits.length < 4) { hideCustomerPreview(); return; }
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(async () => {
      const contacts = await sendMessage({ action: 'lookupInOdoo', number: val });
      if (contacts && contacts.length > 0) showCustomerPreview(contacts, val);
      else hideCustomerPreview();
    }, 500);
  }

  function showCustomerPreview(contacts, number) {
    const existing = document.querySelector('.customer-preview');
    if (existing) existing.remove();
    const c = contacts[0];
    const div = document.createElement('div');
    div.className = 'customer-preview';
    div.style.cssText = `
      background:#E3F2FD;border-radius:8px;padding:10px 12px;margin-bottom:12px;
      font-size:12px;border-left:3px solid #009ddf;
    `;
    div.innerHTML = `
      <div style="font-weight:700;font-size:14px;color:#1a1a1a">${c.name}</div>
      ${c.company_name ? `<div style="color:#555;margin-top:2px">🏢 ${c.company_name}</div>` : ''}
      ${c.email ? `<div style="color:#555">📧 ${c.email}</div>` : ''}
      ${c.phone || c.mobile ? `<div style="color:#009ddf;font-weight:500;margin-top:4px">📞 ${c.phone || c.mobile}</div>` : ''}
      ${contacts.length > 1 ? `<div style="color:#888;font-size:11px;margin-top:4px">+${contacts.length - 1} contacto(s) más</div>` : ''}
    `;
    const display = document.querySelector('.call-display');
    display.parentNode.insertBefore(div, display.nextSibling);
  }

  function hideCustomerPreview() {
    document.querySelectorAll('.customer-preview').forEach(e => e.remove());
  }

  async function callNumber(number) {
    btnCall.disabled = true;
    btnCallText.textContent = 'Llamando...';
    const res = await sendMessage({ action: 'makeCall', destination: number.replace(/[^0-9+]/g, '') });
    if (res?.success) {
      setState('calling');
      showStatus(`Llamada iniciada: ${number}`);
    } else {
      showStatus(`Error: ${res?.error || 'No se pudo llamar'}`, true);
    }
    btnCall.disabled = false;
    btnCallText.textContent = 'Llamar';
  }

  async function hangUp() {
    const res = await sendMessage({ action: 'hangUp' });
    if (res?.success) { setState('idle'); hideStatus(); }
  }

  function setState(state) {
    currentState = state;
    const dot = statusDot; const txt = statusText;
    dot.className = 'status-dot';
    if (state === 'idle' || state === 'connected') {
      dot.classList.add('connected'); txt.textContent = 'Conectado';
      btnCall.style.display = currentNumber ? 'flex' : 'none';
      btnHangup.style.display = 'none';
      btnCallText.textContent = 'Llamar';
    } else if (state === 'calling' || state === 'on_call' || state === 'ringing') {
      dot.classList.add('on-call'); txt.textContent = 'En llamada';
      btnCall.style.display = 'none'; btnHangup.style.display = 'flex';
    } else {
      txt.textContent = 'Desconectado';
    }
  }

  function showStatus(msg, isError = false) {
    callStatus.style.display = 'flex'; callStatusText.textContent = msg;
    callStatus.style.background = isError ? '#FFEBEE' : '#E3F2FD';
    callStatusText.style.color = isError ? '#F44336' : '#1976D2';
  }

  function hideStatus() { callStatus.style.display = 'none'; }

  function sendMessage(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, r)); }

  async function refreshStatus() {
    const r = await sendMessage({ action: 'getStatus' });
    if (r) {
      if (r.callState === 'idle') { setState('idle'); hideStatus(); }
      else { setState(r.callState); showStatus(`Llamada: ${r.currentCall?.destination || ''}`); }
    }
  }

  async function loadCallLog() {
    const log = await sendMessage({ action: 'getCallLog' });
    const container = document.getElementById('callLogList');
    if (!log || log.length === 0) { container.innerHTML = '<div class="log-empty">Sin llamadas registradas</div>'; return; }
    container.innerHTML = log.slice(0, 30).map(e => {
      const t = new Date(e.timestamp);
      const ts = t.toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const d = e.duration ? `${e.duration}s` : '';
      const nm = e.contactName || '';
      return `<div class="log-entry">
        <div class="log-icon ${e.direction}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="${e.direction === 'outbound' ? '#4CAF50' : '#1976D2'}">
            <path d="${e.direction === 'outbound' ? 'M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24 11.36 11.36 0 003.58.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.36 11.36 0 00.57 3.58 1 1 0 01-.25 1.01l-2.2 2.2z' : 'M17 12c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm-1.18 7.5l-2.41-2.41 1.18-1.18 1.23 1.23 3.59-3.59 1.18 1.18-4.77 4.77zM11.5 2C6.81 2 3 5.81 3 10.5S6.81 19 11.5 19h.55c-.03-.33-.05-.66-.05-1 0-3.31 2.69-6 6-6 .66 0 1.3.11 1.89.31.15-.43.25-.87.3-1.31C20.09 5.76 16.23 2 11.5 2z'}"/>
          </svg>
        </div>
        <div class="log-details">
          <div class="log-number">${nm ? `${nm} · ` : ''}${e.number || 'Desconocido'}</div>
          <div class="log-time">${ts} ${d ? `· ${d}` : ''}</div>
        </div>
        <span class="log-status ${e.status}">${e.status === 'completed' ? 'OK' : e.status === 'ringing' ? 'ENT' : '...'}</span>
      </div>`;
    }).join('');
  }

  async function loadSettingsSummary() {
    const c = await sendMessage({ action: 'getConfig' });
    document.getElementById('settingServer').textContent = c.instance || c.customUrl || 'No configurado';
    document.getElementById('settingAuth').textContent = c.authMethod === 'token' ? 'Token API' : 'Usuario/Contraseña';
    document.getElementById('settingAgent').textContent = c.agentName || '---';
    document.getElementById('settingOdoo').textContent = c.odooUrl || 'No configurado';
  }

  async function testConnection() {
    const btn = document.getElementById('btnTestConnection');
    btn.textContent = 'Probando...'; btn.disabled = true;
    const r = await sendMessage({ action: 'authenticate' });
    if (r?.success) { btn.textContent = '✓ Conexión exitosa'; btn.style.borderColor = '#4CAF50'; btn.style.color = '#4CAF50'; refreshStatus(); }
    else { btn.textContent = `✗ ${r?.error || 'Error'}`; btn.style.borderColor = '#F44336'; btn.style.color = '#F44336'; }
    setTimeout(() => { btn.textContent = 'Probar conexión'; btn.style.borderColor = ''; btn.style.color = ''; btn.disabled = false; }, 3000);
  }

  refreshStatus();
});
