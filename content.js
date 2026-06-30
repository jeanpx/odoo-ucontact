let callState = 'idle';
const ODOO_SELECTORS = [
  '.o_field_phone a[href^="tel:"]',
  'a[href^="tel:"]',
  '.o_field_phone',
  '.o_field_phone input[type="tel"]'
];

function init() {
  if (!isOdooPage()) return;
  setupClickToCall();
  injectFloatingButton();
  setupMutationObserver();
  listenForMessages();
}

function isOdooPage() {
  return window.location.hostname.includes('odoo') ||
    document.querySelector('.o_main') ||
    document.querySelector('.o_web_client') ||
    document.querySelector('[data-oe-model]') ||
    document.querySelector('.o_form_view');
}

function setupClickToCall() {
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="tel:"]');
    if (!link || !isOdooPage()) return;
    e.preventDefault();
    e.stopPropagation();
    const number = (link.getAttribute('href') || '').replace(/^tel:/, '').trim();
    if (number) initiateCall(number, link);
  }, true);
}

function initiateCall(number, source) {
  const clean = number.replace(/[^0-9+]/g, '');
  if (!clean) return notify('Número inválido', 'error');

  notify(`Llamando a ${number}...`, 'call');
  highlightField(source, 'calling');

  chrome.runtime.sendMessage({ action: 'makeCall', destination: clean }, (res) => {
    if (res?.success) {
      callState = 'calling';
      notify(`Llamada iniciada ✓`, 'success');
      highlightField(source, 'on_call');
    } else {
      notify(`Error: ${res?.error || 'No se pudo llamar'}`, 'error');
      highlightField(source, 'error');
      setTimeout(() => highlightField(source, 'idle'), 2000);
    }
  });
}

function highlightField(el, state) {
  const colors = { idle: '', calling: '#FF9800', on_call: '#4CAF50', error: '#F44336' };
  const container = el.closest('.o_field_phone') || el;
  container.style.boxShadow = state === 'idle' ? '' : `0 0 0 2px ${colors[state]}`;
  container.style.borderColor = colors[state] || '';
}

function injectFloatingButton() {
  if (document.getElementById('ucontact-odoo-btn')) return;

  const btn = document.createElement('div');
  btn.id = 'ucontact-odoo-btn';
  btn.style.cssText = `
    position:fixed;bottom:24px;right:24px;width:48px;height:48px;
    border-radius:50%;background:linear-gradient(135deg,#009ddf,#0064b4);
    box-shadow:0 4px 16px rgba(0,157,223,0.4);display:flex;align-items:center;
    justify-content:center;cursor:pointer;z-index:99999;
    transition:transform 0.2s,box-shadow 0.2s;
    color:white;font-size:22px;
  `;
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="white"><path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24 11.36 11.36 0 003.58.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.36 11.36 0 00.57 3.58 1 1 0 01-.25 1.01l-2.2 2.2z"/></svg>`;
  btn.title = 'uContact NetPhone';
  btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.1)'; btn.style.boxShadow = '0 6px 24px rgba(0,157,223,0.5)'; });
  btn.addEventListener('mouseleave', () => { btn.style.transform = ''; btn.style.boxShadow = ''; });
  btn.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'getStatus' }));
  document.body.appendChild(btn);

  const dot = document.createElement('div');
  dot.id = 'ucontact-odoo-status';
  dot.style.cssText = `position:absolute;bottom:0;right:0;width:12px;height:12px;border-radius:50%;background:#4CAF50;border:2px solid white;`;
  btn.appendChild(dot);
}

function setupMutationObserver() {
  const obs = new MutationObserver(() => decoratePhones());
  obs.observe(document.body, { childList: true, subtree: true });
  decoratePhones();
}

function decoratePhones() {
  if (!isOdooPage()) return;
  document.querySelectorAll(ODOO_SELECTORS.join(',')).forEach(el => {
    const container = el.closest('.o_field_phone');
    if (!container || container.querySelector('.ucontact-call-icon')) return;

    const icon = document.createElement('button');
    icon.className = 'ucontact-call-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="white"><path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24 11.36 11.36 0 003.58.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.36 11.36 0 00.57 3.58 1 1 0 01-.25 1.01l-2.2 2.2z"/></svg>`;
    icon.title = 'Llamar con uContact';
    icon.style.cssText = `
      display:inline-flex;align-items:center;justify-content:center;
      width:22px;height:22px;border:none;border-radius:50%;
      background:#009ddf;color:white;cursor:pointer;margin-left:4px;
      padding:0;flex-shrink:0;vertical-align:middle;opacity:0;
      transition:opacity 0.2s,transform 0.15s;
    `;
    icon.addEventListener('mouseenter', () => icon.style.transform = 'scale(1.15)');
    icon.addEventListener('mouseleave', () => icon.style.transform = '');
    icon.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const link = container.querySelector('a[href^="tel:"]');
      const num = link ? (link.getAttribute('href') || '').replace(/^tel:/, '').trim() : container.textContent.trim();
      if (num) initiateCall(num, container);
    });
    container.style.position = 'relative';
    container.appendChild(icon);

    container.addEventListener('mouseenter', () => icon.style.opacity = '1');
    container.addEventListener('mouseleave', () => { if (callState !== 'on_call') icon.style.opacity = '0'; });
  });
}

function listenForMessages() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'callState') {
      callState = msg.state;
      const dot = document.getElementById('ucontact-odoo-status');
      if (dot) {
        const colors = { idle: '#4CAF50', calling: '#FF9800', on_call: '#F44336', ringing: '#FF9800' };
        dot.style.background = colors[msg.state] || '#4CAF50';
      }
    }
    if (msg.type === 'incomingCallWithData' || msg.type === 'incomingCall') {
      showOdooIncomingPopup(msg);
    }
  });
}

function showOdooIncomingPopup(msg) {
  const existing = document.getElementById('ucontact-odoo-incoming');
  if (existing) existing.remove();

  const info = msg.callerInfo;
  const popup = document.createElement('div');
  popup.id = 'ucontact-odoo-incoming';
  popup.style.cssText = `
    position:fixed;top:20px;right:20px;z-index:100000;
    background:white;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.18);
    padding:20px;min-width:300px;max-width:400px;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    animation: ucontactSlideIn 0.3s ease-out;
  `;

  const name = info?.name || 'Número desconocido';
  const phone = msg.number || '';
  const email = info?.email || '';
  const company = info?.company_name || '';
  const street = info?.street || '';
  const city = info?.city || '';

  popup.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <div style="width:40px;height:40px;border-radius:50%;background:#E3F2FD;display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="#1976D2">
          <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24 11.36 11.36 0 003.58.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.36 11.36 0 00.57 3.58 1 1 0 01-.25 1.01l-2.2 2.2z"/>
        </svg>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:15px;color:#1a1a1a">${info ? 'Cliente encontrado en Odoo' : 'Llamada entrante'}</div>
        <div style="font-size:12px;color:#888">uContact NetPhone</div>
      </div>
      <button onclick="this.closest('#ucontact-odoo-incoming').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#999;padding:4px">✕</button>
    </div>
    <div style="background:#f8f9fa;border-radius:10px;padding:16px;margin-bottom:14px">
      <div style="font-size:20px;font-weight:700;color:#1a1a1a;margin-bottom:4px">${name}</div>
      ${company ? `<div style="font-size:13px;color:#555;margin-bottom:4px">🏢 ${company}</div>` : ''}
      <div style="font-size:16px;color:#009ddf;font-weight:600;margin:8px 0 4px">${phone}</div>
      ${email ? `<div style="font-size:13px;color:#555">📧 ${email}</div>` : ''}
      ${street ? `<div style="font-size:13px;color:#555;margin-top:2px">📍 ${[street, city].filter(Boolean).join(', ')}</div>` : ''}
    </div>
    ${info ? `<button id="ucontact-odoo-open" style="width:100%;padding:11px;border:none;border-radius:8px;background:#009ddf;color:white;font-weight:600;font-size:14px;cursor:pointer;transition:opacity 0.2s">Abrir contacto en Odoo</button>` : ''}
  `;

  if (info) {
    popup.querySelector('#ucontact-odoo-open').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openInOdoo', model: 'res.partner', id: info.id, viewType: 'form' });
      popup.remove();
    });
  }

  document.head.insertAdjacentHTML('beforeend', `<style>
    @keyframes ucontactSlideIn { from { opacity: 0; transform: translateX(100px); } to { opacity: 1; transform: translateX(0); } }
  </style>`);
  document.body.appendChild(popup);
  setTimeout(() => { const p = document.getElementById('ucontact-odoo-incoming'); if (p) p.remove(); }, 30000);
}

function notify(msg, type = 'info') {
  const colors = { error: '#F44336', success: '#4CAF50', call: '#2196F3', info: '#333' };
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;bottom:20px;right:20px;z-index:100000;
    padding:12px 20px;border-radius:8px;font-family:-apple-system,sans-serif;
    font-size:14px;color:white;box-shadow:0 4px 12px rgba(0,0,0,0.15);
    background:${colors[type] || '#333'};opacity:0;transform:translateY(10px);
    transition:opacity 0.3s,transform 0.3s;max-width:350px;
  `;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; setTimeout(() => el.remove(), 300); }, 3000);
}

init();
