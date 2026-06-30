let lookupTimer = null;
let lastNumberLookedUp = '';
let lastOutputNumber = '';
let outputDebounceTimer = null;
const activePopups = [];
const pendingLookups = {};

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
  chrome.runtime.sendMessage({ action: 'handleIncomingCall', number, extraData: rawData });
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
    cbs.forEach(cb => cb(contacts));
  }).catch((err) => {
    console.error('[uContact Odoo] Lookup error:', err);
    const cbs = pendingLookups[number] || [];
    delete pendingLookups[number];
    cbs.forEach(cb => cb(null));
  });
}

function showCustomerPopup(contacts, number, anchorRect) {
  function ld(v, fmt) { if (!v) return ''; const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return ''; return new Date(+m[1], +m[2]-1, +m[3]).toLocaleDateString('es-PE', fmt || { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  if (!contacts || contacts.length === 0) {
    showNotFoundPopup(number, anchorRect);
    return;
  }
  removeLoadingPopups();

  const contact = contacts[0];
  const popup = document.createElement('div');
  popup.id = 'ucontact-odoo-popup';
  popup.style.cssText = `
    position: fixed; z-index: 2147483647;
    background: white; border-radius: 12px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
    padding: 0; min-width: 320px; max-width: 420px; max-height: calc(100vh - 40px);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px; color: #1a1a1a; line-height: 1.4;
    overflow-y: auto; overflow-x: hidden; animation: ucontactPopupIn 0.25s ease-out;
    cursor: default;
  `;

  const categoryTags = contact.category_id
    ? (Array.isArray(contact.category_id)
      ? contact.category_id.map(c => typeof c === 'object' ? c[1] : c).filter(Boolean).join(', ')
      : '')
    : '';

  const hasDuplicates = contacts.length > 1;

  popup.innerHTML = `
    <div id="ucontact-popup-header" style="cursor: move; background: linear-gradient(135deg, #009ddf, #0064b4); padding: 16px 20px; display: flex; align-items: center; gap: 12px; user-select: none;">
      <div style="width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="white">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
        </svg>
      </div>
      <div style="flex:1; min-width: 0;">
        <div style="font-size: 17px; font-weight: 700; color: white;">${escapeHtml(contact.name)}</div>
        ${categoryTags ? `<div style="font-size: 11px; color: rgba(255,255,255,0.8); margin-top: 2px;">${escapeHtml(categoryTags)}</div>` : ''}
      </div>
      <button id="ucontact-popup-close" style="background: rgba(255,255,255,0.15); border: none; border-radius: 50%; width: 28px; height: 28px; color: white; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">✕</button>
    </div>
    <div style="padding: 16px 20px;">
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        ${contact.phone ? `<div><div style="font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Teléfono</div><div style="font-weight: 600; font-size: 15px; color: #009ddf;">${escapeHtml(contact.phone)}</div></div>` : ''}
        ${contact.mobile ? `<div><div style="font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Móvil</div><div style="font-weight: 600; font-size: 15px; color: #009ddf;">${escapeHtml(contact.mobile)}</div></div>` : ''}
        ${contact.email ? `<div style="grid-column: 1 / -1;"><div style="font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Email</div><div style="font-weight: 500;">${escapeHtml(contact.email)}</div></div>` : ''}
        ${contact.company_name ? `<div><div style="font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Empresa</div><div style="font-weight: 500;">${escapeHtml(contact.company_name)}</div></div>` : ''}
        ${contact.function ? `<div><div style="font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Cargo</div><div style="font-weight: 500;">${escapeHtml(contact.function)}</div></div>` : ''}
        ${contact.website ? `<div><div style="font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;">Web</div><div style="font-weight: 500;">${escapeHtml(contact.website)}</div></div>` : ''}
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; min-width: 0;">
        ${contact._saleOrders && contact._saleOrders.length > 0 ? (() => {
          const debtMap = {};
          if (contact._debt && contact._debt.invoices) {
            for (const inv of contact._debt.invoices) {
              const subId = inv.x_studio_subscription_id && Array.isArray(inv.x_studio_subscription_id) ? inv.x_studio_subscription_id[0] : null;
              if (subId) debtMap[subId] = (debtMap[subId] || 0) + Number(inv.amount_residual || inv.amount_total || 0);
            }
          }
          const totalDebt = contact._debt ? contact._debt.totalDebt : 0;
          function renderSubItem(item, type) {
            if (type === 'task') {
              const stageName = item.stage_id && Array.isArray(item.stage_id) ? item.stage_id[1] : '';
              const projectName = item.project_id && Array.isArray(item.project_id) ? item.project_id[1] : '';
              const deadline = item.date_deadline ? ld(item.date_deadline) : '';
              const sc = stageName ? stageColor(stageName) : { bg: '#5cb85c20', text: '#5cb85c' };
              return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;border-bottom:1px solid #f5f5f5;">
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:600;word-wrap:break-word;overflow-wrap:break-word;">${escapeHtml(item.name)}</div>
                  <div style="font-size:10px;color:#999;">
                    ${projectName ? `<div>${escapeHtml(projectName)}</div>` : ''}
                    ${deadline ? `<div style="margin-top:1px;">📅 ${deadline}</div>` : ''}
                  </div>
                </div>
                ${stageName ? `<span style="flex-shrink:0;margin-left:8px;padding:1px 5px;border-radius:3px;background:${sc.bg};color:${sc.text};font-size:9px;font-weight:600;">${escapeHtml(stageName)}</span>` : ''}
              </div>`;
            }
            if (type === 'ticket') {
              const stageName = item.stage_id && Array.isArray(item.stage_id) ? item.stage_id[1] : '';
              const teamName = item.team_id && Array.isArray(item.team_id) ? item.team_id[1] : '';
              const created = item.create_date ? ld(item.create_date) : '';
              const sc = stageName ? stageColor(stageName) : { bg: '#88888820', text: '#888' };
              return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;border-bottom:1px solid #f5f5f5;">
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:600;word-wrap:break-word;overflow-wrap:break-word;">${escapeHtml(item.name)}</div>
                  <div style="font-size:10px;color:#999;">
                    ${teamName ? `<div>${escapeHtml(teamName)}</div>` : ''}
                    ${created ? `<div style="margin-top:1px;">📅 ${created}</div>` : ''}
                  </div>
                </div>
                ${stageName ? `<span style="flex-shrink:0;margin-left:8px;padding:1px 5px;border-radius:3px;background:${sc.bg};color:${sc.text};font-size:9px;font-weight:600;">${escapeHtml(stageName)}</span>` : ''}
              </div>`;
            }
            if (type === 'noc') {
              const ref = item.x_studio_helpdesk_id && Array.isArray(item.x_studio_helpdesk_id) ? item.x_studio_helpdesk_id[1] : '';
              const opName = item.x_name || '';
              const stageName = item.x_studio_stage_id ? (Array.isArray(item.x_studio_stage_id) ? item.x_studio_stage_id[1] : item.x_studio_stage_id) : '';
              const opDate = item.x_studio_fecha_operacion ? ld(item.x_studio_fecha_operacion) : '';
              const sc = stageName ? stageColor(stageName) : { bg: '#88888820', text: '#888' };
              return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;border-bottom:1px solid #f5f5f5;">
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:600;word-wrap:break-word;overflow-wrap:break-word;">${escapeHtml(opName || ref || item.id)}</div>
                  <div style="font-size:10px;color:#999;">
                    ${ref ? `<div>${escapeHtml(ref)}</div>` : ''}
                    ${opDate ? `<div style="margin-top:1px;">📅 ${opDate}</div>` : ''}
                  </div>
                </div>
                ${stageName ? `<span style="flex-shrink:0;margin-left:8px;padding:1px 5px;border-radius:3px;background:${sc.bg};color:${sc.text};font-size:9px;font-weight:600;">${escapeHtml(stageName)}</span>` : ''}
              </div>`;
            }
            return '';
          }
          const dataRows = contact._saleOrders.map(o => {
            const debt = debtMap[o.id] || 0;
            const stageName = o.stage_id && Array.isArray(o.stage_id) ? o.stage_id[1] : '';
            const date = o.date_order ? ld(o.date_order) : '';
            const sc = stageName ? stageColor(stageName) : { bg: '#009ddf20', text: '#009ddf' };
            const shipId = o.partner_shipping_id && Array.isArray(o.partner_shipping_id) ? o.partner_shipping_id[0] : null;
            const tasks = shipId ? (contact._tasks || []).filter(t => t.x_studio_partner_shipping_id && Array.isArray(t.x_studio_partner_shipping_id) && t.x_studio_partner_shipping_id[0] === shipId).slice(0, 5) : [];
            const tickets = shipId ? (contact._tickets || []).filter(t => t.x_studio_partner_shipping_id && Array.isArray(t.x_studio_partner_shipping_id) && t.x_studio_partner_shipping_id[0] === shipId).slice(0, 5) : [];
            const nocs = shipId ? (contact._customTickets || []).filter(n => n.x_studio_partner_shipping_id && Array.isArray(n.x_studio_partner_shipping_id) && n.x_studio_partner_shipping_id[0] === shipId).slice(0, 5) : [];
            const hasRelated = tasks.length > 0 || tickets.length > 0 || nocs.length > 0;
            return `
              <div data-sub-id="${o.id}" data-sub-name="${escapeHtml(o.name.split(/\s*-\s*/)[0] || o.name)}" style="cursor:pointer;" onclick="(function(el){var d=el.nextElementSibling;if(d&&d.classList.contains('ucontact-sub-details')){var show=d.style.display!=='none';d.style.display=show?'none':'';el.querySelector('.ucontact-expand-icon').textContent=show?'▶':'▼';el.style.background=show?'':'#e8f4fd';el.style.borderRadius=show?'':'6px';}})(this)">
                <div style="display: flex; gap: 12px; align-items: center; padding: 6px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px;">
                  <div style="flex: 1; overflow: hidden;">
                    <div><span class="ucontact-expand-icon" style="font-size:10px;color:#aaa;margin-right:4px;">▶</span><span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(o.name.split(/\s*-\s*/)[0] || o.name)}</span></div>
                    <div style="font-size: 11px; color: #999;">${date} ${stageName ? `· <span style="color:${sc.text};">${escapeHtml(stageName)}</span>` : ''}</div>
                    ${o.partner_shipping_id ? `<div style="font-size: 11px; color: #999; margin-top: 2px;">🏠 ${escapeHtml((Array.isArray(o.partner_shipping_id) ? o.partner_shipping_id[1] : '').replace(/^[^,]+,\s*/, ''))}</div>` : ''}
                  </div>
                  <div style="width: 100px; text-align: right; font-weight: 600;">S/ ${Number(o.amount_total || 0).toFixed(2)}</div>
                  <div style="width: 90px; text-align: right; font-weight: 600; color: ${debt > 0 ? '#d9534f' : '#5cb85c'};">${debt > 0 ? `S/ ${debt.toFixed(2)}` : 'S/ 0.00'}</div>
                </div>
              </div>
              <div class="ucontact-sub-details" style="display:none;padding:4px 0 4px 12px;background:#fafafa;border-bottom:1px solid #f0f0f0;font-size:12px;">
                ${tasks.length > 0 ? `<div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin:4px 0 2px;">Tareas</div>${tasks.map(t => renderSubItem(t, 'task')).join('')}` : ''}
                ${tickets.length > 0 ? `<div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin:4px 0 2px;">Tickets</div>${tickets.map(t => renderSubItem(t, 'ticket')).join('')}` : ''}
                ${nocs.length > 0 ? `<div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin:4px 0 2px;">NOC</div>${nocs.map(n => renderSubItem(n, 'noc')).join('')}` : ''}
                ${!hasRelated ? `<div style="color:#aaa;padding:4px 0;">Sin registros relacionados</div>` : ''}
              </div>`;
          }).join('');
          const totalRow = totalDebt > 0 ? `
            <div style="display: flex; gap: 12px; align-items: center; padding: 8px 0; border-top: 2px solid #f0f0f0; font-size: 13px;">
              <div style="flex: 1;"></div>
              <div style="width: 100px; text-align: right; font-weight: 600; color: #333;">Deuda total:</div>
              <div style="width: 90px; text-align: right; font-size: 18px; font-weight: 700; color: #d9534f;">S/ ${totalDebt.toFixed(2)}</div>
            </div>` : '';
          return `<div style="grid-column: 1 / -1; padding-top: 14px; border-top: 1px solid #f0f0f0; min-width: 0; overflow-wrap: break-word;">
            <div style="font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Suscripciones</div>
            <div style="display: flex; gap: 12px; align-items: center; padding: 4px 0; border-bottom: 1px solid #eee; font-size: 10px; color: #aaa; text-transform: uppercase; letter-spacing: 0.5px;">
              <div style="flex: 1;">Pedido</div>
              <div style="width: 100px; text-align: right;">Total</div>
              <div style="width: 90px; text-align: right;">Deuda</div>
            </div>
            ${dataRows}
            ${totalRow}
          </div>`;
        })() : ''}
      </div>
      ${hasDuplicates ? `
        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #f0f0f0;">
          <div style="font-size: 11px; color: #888; margin-bottom: 6px;">Otros contactos con este número:</div>
          ${contacts.slice(1, 4).map(c => `<div style="font-size: 13px; padding: 4px 0;">• ${escapeHtml(c.name)}${c.company_name ? ` — ${escapeHtml(c.company_name)}` : ''}</div>`).join('')}
        </div>
      ` : ''}
    </div>
  `;

  popup.querySelector('#ucontact-popup-close').addEventListener('click', (e) => {
    e.stopPropagation();
    removePopup(popup);
  });

  document.body.appendChild(popup);

  // Make popup draggable via header
  const header = popup.querySelector('#ucontact-popup-header');
  if (header) {
    let isDragging = false, dragStartX, dragStartY, origX, origY;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('#ucontact-popup-close')) return;
      isDragging = true;
      const rect = popup.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      popup.style.transition = 'none';
      popup.style.animation = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      popup.style.left = (origX + (e.clientX - dragStartX)) + 'px';
      popup.style.top = (origY + (e.clientY - dragStartY)) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        popup.style.transition = '';
      }
    });
  }

  positionPopup(popup, anchorRect);

  // Right-click context menu for subscriptions
  popup.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-sub-id]');
    if (!row) return;
    e.preventDefault();
    const existing = popup.querySelector('.ucontact-ctx-menu');
    if (existing) existing.remove();
    const menu = document.createElement('div');
    menu.className = 'ucontact-ctx-menu';
    menu.style.cssText = `position:fixed;z-index:2147483647;background:white;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.2);padding:4px 0;font-size:13px;min-width:180px;left:${e.clientX}px;top:${e.clientY}px;`;
    menu.innerHTML = `
      <div data-action="open-sub" data-id="${row.dataset.subId}" style="padding:8px 16px;cursor:pointer;">Abrir en Odoo</div>
      <div data-action="copy-sub" data-name="${escapeHtml(row.dataset.subName)}" style="padding:8px 16px;cursor:pointer;">Copiar nombre</div>`;
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 0);
    menu.querySelector('[data-action="open-sub"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openInOdoo', model: 'sale.order', id: parseInt(menu.querySelector('[data-action="open-sub"]').dataset.id), viewType: 'form' });
      close();
    });
    menu.querySelector('[data-action="copy-sub"]').addEventListener('click', () => {
      navigator.clipboard.writeText(menu.querySelector('[data-action="copy-sub"]').dataset.name);
      close();
    });
  });

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
    <div id="ucontact-popup-header" style="cursor: move; background: linear-gradient(135deg, #888, #555); padding: 14px 20px; display: flex; align-items: center; gap: 12px; user-select: none;">
      <div style="width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="white">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
      </div>
      <div style="flex:1;">
        <div style="font-size: 15px; font-weight: 600; color: white;">Cliente no encontrado</div>
        <div style="font-size: 12px; color: rgba(255,255,255,0.7); margin-top: 1px;">${escapeHtml(number)}</div>
      </div>
      <button id="ucontact-popup-close" style="background: rgba(255,255,255,0.15); border: none; border-radius: 50%; width: 26px; height: 26px; color: white; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">✕</button>
    </div>
    <div style="padding: 20px; text-align: center;">
      <div style="font-size: 13px; color: #888; margin-bottom: 4px;">El número no está registrado</div>
      <div style="font-size: 12px; color: #aaa;">en Odoo como contacto</div>
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

function stageColor(name) {
  if (/baja/i.test(name)) return { bg: '#fce4e4', text: '#c0392b' };
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return { bg: `hsl(${h}, 45%, 92%)`, text: `hsl(${h}, 55%, 30%)` };
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
