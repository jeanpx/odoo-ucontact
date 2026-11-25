let lookupTimer = null;
let lastNumberLookedUp = '';
let lastOutputNumber = '';
let outputDebounceTimer = null;
const activePopups = [];
const pendingLookups = {};
const lookupErrors = {};

console.log('[uContact Odoo] Content script loaded, hostname:', window.location.hostname);

function init() {
  console.log('[uContact Odoo] init() called');
  listenForPostMessages();
  monitorPhoneInput();
  monitorOutputTextarea();
  injectCustomerPopupStyles();
  detectClickToCall();
  detectCallInDOM();
}

function monitorOutputTextarea() {
  const output = document.getElementById('output') || document.querySelector('textarea#output');
  if (!output) {
    // Watch for it to appear
    const obs = new MutationObserver(() => {
      const el = document.getElementById('output') || document.querySelector('textarea#output');
      if (el && !el.dataset.ucontactOutputMonitored) {
        el.dataset.ucontactOutputMonitored = '1';
        console.log('[uContact Odoo] Output textarea found');
        setupOutputListener(el);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return;
  }
  console.log('[uContact Odoo] Output textarea found immediately');
  setupOutputListener(output);
}

function setupOutputListener(output) {
  let lastVal = output.value;
  
  ['input', 'change', 'propertychange', 'DOMNodeInserted', 'DOMCharacterDataModified'].forEach(evt => {
    output.addEventListener(evt, () => checkOutput(output));
  });
  
  const obs = new MutationObserver(() => checkOutput(output));
  obs.observe(output, { attributes: true, childList: true, subtree: true, characterData: true });
  
  setInterval(() => {
    if (output.value !== lastVal) {
      lastVal = output.value;
      checkOutput(output);
    }
  }, 500);
  
  checkOutput(output);
}

function checkOutput(output) {
  const raw = (output.value || output.textContent || '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 7) return;
  if (digits === lastOutputNumber) return;
  lastOutputNumber = digits;

  if (outputDebounceTimer) clearTimeout(outputDebounceTimer);
  outputDebounceTimer = setTimeout(() => {
    console.log('[uContact Odoo] Number stable, looking up:', digits);
    const rect = output.getBoundingClientRect();
    showLoadingPopup(digits, rect);
    lookupNumber(digits, (contacts) => {
      console.log('[uContact Odoo] Lookup response:', contacts ? contacts.length + ' contacts' : 'null');
      if (contacts && contacts.length > 0) {
        showCustomerPopup(contacts, digits, rect);
      } else {
        showNotFoundPopup(digits, rect);
      }
    });
  }, 800);
}

function isUcontactPage() {
  return window.location.hostname.includes('ucontactcloud') ||
    window.location.hostname.includes('ucontact') ||
    window.location.hostname.includes('uphone');
}

function listenForPostMessages() {
  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (typeof data === 'object' && Object.keys(data).length > 0) {
      console.log('[uContact Odoo] postMessage from', event.origin, 'action:', data.action || data.event || data.type || '(no action/event/type)', 'keys:', Object.keys(data).join(','));
      console.log('[uContact Odoo] postMessage data:', JSON.stringify(data).substring(0, 300));

      if (data.action === 'gettingCall' && data.params?.number) {
        console.log('[uContact Odoo] Incoming call detected:', data.params.number);
        handleIncomingCall(data.params.number, data);
      }
      else if (data.action === 'makeCall' && data.params?.number) {
        console.log('[uContact Odoo] Outgoing call detected:', data.params.number);
        handleOutgoingCall(data.params.number, data);
      }
      else if (data.action === 'finishedCall') {
        console.log('[uContact Odoo] Call ended');
        handleCallEnded(data);
      }
      else if (data.action === 'agentLogin') {
        console.log('[uContact Odoo] Agent logged in:', data.params?.fullname);
      }
      else if (data.event === 'assignedInteraction') {
        const interaction = data.data || {};
        const number = interaction.number || interaction.callerId || interaction.from || '';
        if (number) {
          console.log('[uContact Odoo] Assigned interaction:', number);
          handleIncomingCall(number, data);
        }
      }
      else if (data.event === 'finishedInteraction') {
        handleCallEnded(data);
      }
    }
  });
}

function monitorPhoneInput() {
  const observer = new MutationObserver(() => {
    findPhoneInputs();
    findDialerInput();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  findPhoneInputs();
  findDialerInput();
}

function findDialerInput() {
  // Look for the uPhone dialer input - it might be in an iframe or shadow DOM
  const dialInputs = document.querySelectorAll(
    'input[placeholder*="marcar" i], input[placeholder*="dial" i], input[placeholder*="phone" i], ' +
    'input[placeholder*="number" i], input[placeholder*="tel" i], input[data-component*="dial" i], ' +
    'input.dialer-input, input.phone-input, input[class*="dial"], input[class*="phone"], ' +
    '[class*="dialer"] input, [class*="softphone"] input, [id*="dial"] input, [id*="phone"] input'
  );

  dialInputs.forEach(input => {
    if (input.dataset.ucontactDialMonitored) return;
    input.dataset.ucontactDialMonitored = 'true';
    console.log('[uContact Odoo] Dialer input found:', input.placeholder || input.id || input.className || '(unknown)');
    
    ['input', 'change', 'propertychange'].forEach(evt => {
      input.addEventListener(evt, () => onPhoneInput(input));
    });
    
    // Check current value immediately
    if (input.value) onPhoneInput(input);
  });
}

function findPhoneInputs() {
  const inputs = document.querySelectorAll('input[type="tel"], input[placeholder*="tel"], input[placeholder*="phone"], input[placeholder*="Phone"], input[placeholder*="número"], input[placeholder*="numero"], input[placeholder*="Number"], input[name*="phone"], input[name*="number"], input[aria-label*="phone" i], input[aria-label*="call" i], input[aria-label*="dial" i]');

  inputs.forEach((input) => {
    if (input.dataset.ucontactMonitored) return;
    input.dataset.ucontactMonitored = 'true';
    input.addEventListener('input', () => onPhoneInput(input));
    input.addEventListener('change', () => onPhoneInput(input));
  });

  const phoneContainers = document.querySelectorAll('[class*="phone"], [class*="Phone"], [class*="dial"], [class*="Dial"], [class*="softphone"], [class*="Softphone"], [id*="phone"], [id*="Phone"], [id*="dial"]');
  phoneContainers.forEach((container) => {
    const textInputs = container.querySelectorAll('input[type="text"], input:not([type])');
    textInputs.forEach((input) => {
      if (input.dataset.ucontactMonitored) return;
      if (input.closest('.o_field_phone')) return;
      input.dataset.ucontactMonitored = 'true';
      input.addEventListener('input', () => onPhoneInput(input));
      input.addEventListener('change', () => onPhoneInput(input));
    });
  });

  const allInputs = document.querySelectorAll('input');
  allInputs.forEach((input) => {
    if (input.dataset.ucontactMonitored) return;
    if (input.type === 'text' || !input.type) {
      const val = input.value;
      if (val && /^[+\d\s\-()]{7,}$/.test(val.trim())) {
        input.dataset.ucontactMonitored = 'true';
        input.addEventListener('input', () => onPhoneInput(input));
        input.addEventListener('change', () => onPhoneInput(input));
      }
    }
  });
}

function onPhoneInput(input) {
  const value = (input.value || '').trim();
  const digits = value.replace(/[^0-9]/g, '');

  if (digits.length < 7) return;

  if (digits === lastNumberLookedUp) return;

  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(() => {
    lastNumberLookedUp = digits;
    lookupAndShowCustomer(digits, input);
  }, 600);
}

function lookupAndShowCustomer(number, inputElement) {
  const rect = inputElement ? inputElement.getBoundingClientRect() : null;
  showLoadingPopup(number, rect);
  lookupNumber(number, (response) => {
    if (!response || response.length === 0) {
      showNotFoundPopup(number, rect);
      return;
    }
    showCustomerPopup(response, number, rect);
  });
}

function handleIncomingCall(number, rawData) {
  const digits = String(number).replace(/[^0-9]/g, '');
  // Evita que el monitor del textarea/dialer dispare un segundo popup para el mismo número
  lastOutputNumber = digits;
  lastNumberLookedUp = digits;
  hideCustomerPopup();
  const rect = findSoftphoneRect();
  showLoadingPopup(number, rect);
  lookupNumber(number, (contacts) => {
    console.log('[uContact Odoo] handleIncomingCall: lookup result:', contacts?.length || 0, 'contacts');
    if (contacts && contacts.length > 0) {
      showCustomerPopup(contacts, number, rect);
    } else {
      showNotFoundPopup(number, rect);
    }
    // El background reutiliza el resultado en caché para el badge, el log y la notificación
    chrome.runtime.sendMessage({ action: 'handleIncomingCall', number, extraData: rawData }).catch(() => {});
  });
}

function handleOutgoingCall(number, rawData) {
  const rect = findSoftphoneRect();
  showLoadingPopup(number, rect);
  lookupNumber(number, (contacts) => {
    console.log('[uContact Odoo] handleOutgoingCall: lookup result:', contacts?.length || 0, 'contacts');
    if (contacts && contacts.length > 0) {
      broadcastToPopup({ type: 'outgoingCallWithData', number, contacts });
      showCustomerPopup(contacts, number, rect);
    } else {
      showNotFoundPopup(number, rect);
    }
  });
}

function handleCallEnded(data) {
  broadcastToPopup({ type: 'callEnded' });
  setTimeout(hideCustomerPopup, 500);
}

function findSoftphoneRect() {
  const softphone = document.querySelector('[class*="softphone"], [class*="Softphone"], [class*="uphone"], [class*="Uphone"], [id*="softphone"], [id*="uphone"], [class*="phone-box"], [class*="dialer"]');
  if (softphone) return softphone.getBoundingClientRect();
  return null;
}

function removeLoadingPopups() {
  for (let i = activePopups.length - 1; i >= 0; i--) {
    const p = activePopups[i];
    if (p.querySelector('.ucontact-spinner')) {
      removePopup(p);
    }
  }
}

function lookupNumber(number, onResult) {
  if (pendingLookups[number]) {
    pendingLookups[number].push(onResult);
    return;
  }
  pendingLookups[number] = [onResult];
  chrome.runtime.sendMessage({ action: 'lookupInOdoo', number }).then((contacts) => {
    const cbs = pendingLookups[number] || [];
    delete pendingLookups[number];
    if (contacts && contacts.error) {
      // Guardar el error para que showNotFoundPopup lo muestre en vez de "no encontrado"
      console.error('[uContact Odoo] Lookup error:', contacts.error);
      lookupErrors[number] = contacts.error;
      cbs.forEach(cb => cb(null));
      return;
    }
    delete lookupErrors[number];
    cbs.forEach(cb => cb(contacts));
  }).catch((err) => {
    console.error('[uContact Odoo] Lookup error:', err);
    lookupErrors[number] = 'No se pudo comunicar con la extensión. Recarga la página.';
    const cbs = pendingLookups[number] || [];
    delete pendingLookups[number];
    cbs.forEach(cb => cb(null));
  });
}

function showCustomerPopup(contacts, number, anchorRect) {
  function ld(v) { if (!v) return ''; const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }
  if (!contacts || contacts.length === 0) {
    showNotFoundPopup(number, anchorRect);
    return;
  }
  removeLoadingPopups();

  const contact = contacts[0];
  const addresses = serviceAddresses(contact);
  const totalDebt = contact._debt ? Number(contact._debt.totalDebt || 0) : 0;
  const debtCount = contact._debt ? (contact._debt.invoiceCount || 0) : 0;
  const docType = Array.isArray(contact.l10n_latam_identification_type_id) ? contact.l10n_latam_identification_type_id[1] : 'DNI';
  const phone = contact.mobile || contact.phone || '';
  const meta = [contact.vat ? `${docType} ${contact.vat}` : '', phone].filter(Boolean);
  const label = 'font-size:11px;color:#9aa0a6;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;';

  const popup = document.createElement('div');
  popup.id = 'ucontact-odoo-popup';
  popup.style.cssText = `
    position: fixed; z-index: 2147483647; width: 340px; max-height: calc(100vh - 40px);
    background: #fff; border-radius: 10px; border-top: 3px solid ${totalDebt > 0 ? '#d93025' : '#1e8e3e'};
    box-shadow: 0 6px 24px rgba(0,0,0,.16);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px; color: #202124; line-height: 1.4;
    overflow-y: auto; overflow-x: hidden; animation: ucontactPopupIn .2s ease-out;
  `;

  popup.innerHTML = `
    <div id="ucontact-popup-header" style="cursor:move;user-select:none;padding:14px 16px 10px;display:flex;gap:8px;align-items:flex-start;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:15px;font-weight:600;">${escapeHtml(contact.name)}</div>
        ${meta.length ? `<div style="font-size:12px;color:#5f6368;margin-top:2px;">${meta.map(escapeHtml).join(' · ')}</div>` : ''}
      </div>
      <button id="ucontact-popup-close" title="Cerrar" style="background:none;border:none;color:#9aa0a6;font-size:16px;cursor:pointer;padding:0 2px;line-height:1;">✕</button>
    </div>

    <div style="padding:0 16px 14px;">
      ${addresses.length ? `
        <div style="padding:10px 0;border-top:1px solid #f1f3f4;">
          <div style="${label}">Dirección</div>
          ${addresses.map(a => `<div>${escapeHtml(a)}</div>`).join('')}
        </div>` : ''}

      <div style="padding:10px 0;border-top:1px solid #f1f3f4;display:flex;justify-content:space-between;align-items:baseline;">
        <div style="${label}margin:0;">Deuda</div>
        <div style="text-align:right;">
          <span style="font-size:16px;font-weight:600;color:${totalDebt > 0 ? '#d93025' : '#1e8e3e'};">S/ ${totalDebt.toFixed(2)}</span>
          ${totalDebt > 0 ? `<span style="font-size:11px;color:#5f6368;margin-left:4px;">${debtCount} fact.</span>` : ''}
        </div>
      </div>

      ${contact._lastInvoices && contact._lastInvoices.length ? `
        <div style="padding-top:10px;border-top:1px solid #f1f3f4;">
          <div style="${label}">Últimas facturas</div>
          ${contact._lastInvoices.map(inv => {
            const st = invoiceStatus(inv.payment_state);
            return `<div data-invoice-id="${inv.id}" title="Abrir en Odoo" style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;">
              <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(inv.name)}</span>
              <span style="color:#9aa0a6;font-size:12px;">${ld(inv.invoice_date)}</span>
              <span style="width:68px;text-align:right;">S/ ${Number(inv.amount_total || 0).toFixed(2)}</span>
              <span title="${st.label}" style="width:8px;height:8px;border-radius:50%;background:${st.text};flex-shrink:0;"></span>
            </div>`;
          }).join('')}
          <div style="display:flex;gap:12px;margin-top:6px;font-size:11px;color:#9aa0a6;">
            ${['paid', 'partial', 'not_paid'].map(k => { const s = invoiceStatus(k); return `<span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${s.text};margin-right:4px;vertical-align:middle;"></span>${s.label}</span>`; }).join('')}
          </div>
        </div>` : ''}
    </div>
  `;

  popup.querySelector('#ucontact-popup-close').addEventListener('click', (e) => {
    e.stopPropagation();
    removePopup(popup);
  });

  popup.querySelectorAll('[data-invoice-id]').forEach(row => {
    row.addEventListener('mouseenter', () => { row.style.background = '#f8f9fa'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });
    row.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openInOdoo', model: 'account.move', id: parseInt(row.dataset.invoiceId), viewType: 'form' });
    });
  });

  document.body.appendChild(popup);

  // Make popup draggable via header
  const header = popup.querySelector('#ucontact-popup-header');
  let isDragging = false, dragStartX, dragStartY, origX, origY;
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('#ucontact-popup-close')) return;
    isDragging = true;
    const rect = popup.getBoundingClientRect();
    origX = rect.left; origY = rect.top;
    dragStartX = e.clientX; dragStartY = e.clientY;
    popup.style.animation = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    popup.style.left = (origX + (e.clientX - dragStartX)) + 'px';
    popup.style.top = (origY + (e.clientY - dragStartY)) + 'px';
  });
  document.addEventListener('mouseup', () => { isDragging = false; });

  positionPopup(popup, anchorRect);
  activePopups.push(popup);
}

function positionPopup(popup, anchorRect) {
  const pad = 12;
  let top = 80;
  let left = Math.max(pad, window.innerWidth - popup.offsetWidth - pad);

  if (anchorRect) {
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    if (spaceBelow > popup.offsetHeight + 20) {
      top = anchorRect.bottom + 8;
    } else if (spaceAbove > popup.offsetHeight + 20) {
      top = anchorRect.top - popup.offsetHeight - 8;
    } else {
      top = Math.max(pad, anchorRect.top);
    }
    left = Math.min(anchorRect.left, window.innerWidth - popup.offsetWidth - pad);
    left = Math.max(pad, left);
  }

  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;
}

function removePopup(popup) {
  if (!popup || !popup.parentNode) return;
  if (popup._autoTimeout) clearTimeout(popup._autoTimeout);
  popup.remove();
  const idx = activePopups.indexOf(popup);
  if (idx >= 0) activePopups.splice(idx, 1);
}

function hideCustomerPopup() {
  while (activePopups.length > 0) {
    const p = activePopups[0];
    removePopup(p);
  }
}

function showNotFoundPopup(number, anchorRect) {
  removeLoadingPopups();
  const errorMsg = lookupErrors[number] || '';
  const popup = document.createElement('div');
  popup.id = 'ucontact-odoo-popup';
  popup.style.cssText = `
    position: fixed; z-index: 2147483647;
    background: white; border-radius: 12px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
    padding: 0; min-width: 280px; max-width: 360px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px; color: #1a1a1a; line-height: 1.4;
    overflow: hidden; animation: ucontactPopupIn 0.25s ease-out;
    cursor: default;
  `;

  popup.innerHTML = `
    <div id="ucontact-popup-header" style="cursor: move; background: ${errorMsg ? 'linear-gradient(135deg, #e06666, #b03a2e)' : 'linear-gradient(135deg, #888, #555)'}; padding: 14px 20px; display: flex; align-items: center; gap: 12px; user-select: none;">
      <div style="width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
      </div>
      <div style="flex:1;">
        <div style="font-size: 15px; font-weight: 600; color: white;">${errorMsg ? 'Error al consultar Odoo' : 'Cliente no encontrado'}</div>
        <div style="font-size: 12px; color: rgba(255,255,255,0.7); margin-top: 1px;">${escapeHtml(number)}</div>
      </div>
      <button id="ucontact-popup-close" style="background: rgba(255,255,255,0.15); border: none; border-radius: 50%; width: 26px; height: 26px; color: white; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">✕</button>
    </div>
    <div style="padding: 20px; text-align: center;">
      ${errorMsg ? `<div style="font-size: 13px; color: #b03a2e; word-wrap: break-word;">${escapeHtml(errorMsg)}</div>` : `
      <div style="font-size: 13px; color: #888; margin-bottom: 4px;">El número no está registrado</div>
      <div style="font-size: 12px; color: #aaa;">en Odoo como contacto</div>`}
    </div>
  `;

  popup.querySelector('#ucontact-popup-close').addEventListener('click', (e) => {
    e.stopPropagation();
    removePopup(popup);
  });

  const header = popup.querySelector('#ucontact-popup-header');
  if (header) {
    let isDragging = false, dragStartX, dragStartY, origX, origY;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('#ucontact-popup-close')) return;
      isDragging = true;
      const rect = popup.getBoundingClientRect();
      origX = rect.left; origY = rect.top;
      dragStartX = e.clientX; dragStartY = e.clientY;
      popup.style.transition = 'none';
      popup.style.animation = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      popup.style.left = (origX + (e.clientX - dragStartX)) + 'px';
      popup.style.top = (origY + (e.clientY - dragStartY)) + 'px';
    });
    document.addEventListener('mouseup', () => { isDragging = false; popup.style.transition = ''; });
  }

  document.body.appendChild(popup);
  positionPopupSimple(popup, null);

  activePopups.push(popup);
}

function showLoadingPopup(number, anchorRect) {
  const popup = document.createElement('div');
  popup.id = 'ucontact-odoo-popup';
  popup.style.cssText = `
    position: fixed; z-index: 2147483647;
    background: white; border-radius: 12px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
    padding: 0; min-width: 260px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px; color: #1a1a1a; line-height: 1.4;
    overflow: hidden; animation: ucontactPopupIn 0.25s ease-out;
    cursor: default;
  `;

  popup.innerHTML = `
    <div style="padding: 20px 24px; display: flex; align-items: center; gap: 14px;">
      <div class="ucontact-spinner" style="width: 22px; height: 22px; border: 3px solid #e0e0e0; border-top-color: #009ddf; border-radius: 50%; flex-shrink: 0;"></div>
      <div>
        <div style="font-size: 14px; font-weight: 600; color: #333;">Buscando en Odoo...</div>
        <div style="font-size: 12px; color: #999; margin-top: 2px;">${escapeHtml(number)}</div>
      </div>
    </div>
  `;

  document.body.appendChild(popup);
  positionPopupSimple(popup, anchorRect);

  activePopups.push(popup);
}

function positionPopupSimple(popup, anchorRect) {
  const pad = 12;
  popup.style.top = `${80}px`;
  popup.style.left = `${Math.max(pad, window.innerWidth - popup.offsetWidth - pad)}px`;
  if (anchorRect) {
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    if (spaceBelow > popup.offsetHeight + 20) popup.style.top = `${anchorRect.bottom + 8}px`;
    else popup.style.top = `${Math.max(pad, anchorRect.top)}px`;
    popup.style.left = `${Math.max(pad, Math.min(anchorRect.left, window.innerWidth - popup.offsetWidth - pad))}px`;
  }
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Direcciones del servicio (entrega de las suscripciones); si no hay, la de la ficha
function serviceAddresses(contact) {
  const out = [];
  for (const o of contact._saleOrders || []) {
    const ps = o.partner_shipping_id;
    if (!Array.isArray(ps) || ps[0] === contact.id) continue;
    const addr = String(ps[1] || '').replace(/^[^,]+,\s*/, '').trim();
    if (addr && !out.includes(addr)) out.push(addr);
  }
  if (out.length) return out.slice(0, 3);
  const name = (v) => Array.isArray(v) ? v[1] : (v || '');
  const own = [contact.street, contact.street2, contact.city, name(contact.state_id).replace(/\s*\([A-Z]{2}\)$/, '')]
    .filter(p => p && p !== contact.name).join(', ');
  return own ? [own] : [];
}

function invoiceStatus(paymentState) {
  switch (paymentState) {
    case 'paid': return { label: 'Pagada', bg: '#e6f4ea', text: '#1e8e3e' };
    case 'in_payment': return { label: 'En pago', bg: '#e8f4fd', text: '#0064b4' };
    case 'partial': return { label: 'Parcial', bg: '#fef7e0', text: '#f29900' };
    case 'reversed': return { label: 'Revertida', bg: '#f0f0f0', text: '#777' };
    default: return { label: 'Pendiente', bg: '#fce8e6', text: '#d93025' };
  }
}

function injectCustomerPopupStyles() {
  const style = document.createElement('style');
  style.id = 'ucontact-odoo-styles';
  style.textContent = `
    @keyframes ucontactPopupIn {
      from { opacity: 0; transform: translateY(-12px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes ucontactSpinner {
      to { transform: rotate(360deg); }
    }
    #ucontact-odoo-popup {
      animation: ucontactPopupIn 0.25s ease-out;
    }
    .ucontact-spinner {
      animation: ucontactSpinner 0.8s linear infinite !important;
    }
    .ucontact-odoo-btn:hover {
      opacity: 0.9;
    }
    .ucontact-odoo-btn:active {
      transform: scale(0.97);
    }
  `;
  document.head.appendChild(style);
}

function detectClickToCall() {
  document.addEventListener('click', (e) => {
    let target = e.target.closest('a[href^="tel:"], [class*="call"], [class*="dial"], [class*="llamar"], [class*="marcar"], [id*="call"], [id*="dial"], [data-action*="call"], [data-action*="dial"]');
    
    if (!target) {
      const el = e.target;
      const text = (el.textContent || el.title || el.getAttribute('aria-label') || '').trim();
      if (/^[\+\d][\d\s\-\(\)]{6,}$/.test(text) || /tel[eé]fono|m[vó]vil|phone|mobile/i.test(text)) {
        target = el;
      }
    }

    if (target) {
      const text = target.textContent || target.title || target.getAttribute('aria-label') || target.innerText || '';
      const numbers = text.match(/[\+\d][\d\s\-\(\)]{7,}/g);
      if (numbers) {
        const num = numbers[0].replace(/[^0-9]/g, '');
        if (num.length >= 7) {
          console.log('[uContact Odoo] Click-to-call detected:', num);
          const rect = target.getBoundingClientRect();
          showLoadingPopup(num, rect);
          lookupNumber(num, (contacts) => {
            if (contacts && contacts.length > 0) {
              showCustomerPopup(contacts, num, rect);
            } else {
              showNotFoundPopup(num, rect);
            }
          });
        }
      }
    }
  }, true);
}

function detectCallInDOM() {
  const seen = new Set();
  setInterval(() => {
    const elements = document.querySelectorAll('[class*="call"], [class*="llamada"], [class*="active-call"], [class*="call-info"], [class*="caller"], [id*="call"], [id*="llamada"], [class*="contact-card"], [class*="contact-info"], [class*="caller-info"]');
    elements.forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);
      const text = el.textContent || '';
      const numbers = text.match(/[\+\d][\d\s\-\(\)]{7,}/g);
      if (numbers) {
        const num = numbers[0].replace(/[^0-9]/g, '');
        if (num.length >= 7 && !el.dataset.ucontactChecked) {
          el.dataset.ucontactChecked = '1';
          console.log('[uContact Odoo] Call element detected:', num);
          const rect = el.getBoundingClientRect();
          showLoadingPopup(num, rect);
          lookupNumber(num, (contacts) => {
            if (contacts && contacts.length > 0) {
              showCustomerPopup(contacts, num, rect);
            } else {
              showNotFoundPopup(num, rect);
            }
          });
        }
      }
    });
  }, 2000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
