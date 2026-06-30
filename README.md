# uContact ↔ Odoo Integration

Extensión de Chrome que integra la telefonia uContact con Odoo. Cuando un agente recibe una llamada, la extensión detecta el número en la interfaz de uContact, busca el contacto en Odoo y muestra un popup con información del cliente, sus suscripciones, deudas, tareas, tickets y NOC.

## Funcionalidades

- **Detección automática** de números telefónicos en la interfaz de uContact
- **Búsqueda en Odoo** vía JSON-RPC con patrón flexible (coincide números sin importar formato)
- **Popup interactivo** con:
  - Datos del contacto (nombre, teléfono, email, empresa, categorías)
  - **Suscripciones**: pedidos con total y deuda por facturas impagas
  - Expansión por clic: cada suscripción muestra sus tareas, tickets y NOC relacionados
  - Clic derecho: menú contextual para abrir en Odoo o copiar nombre
  - Arrastrable y redimensionable

## Instalación

1. Abre `chrome://extensions`
2. Activa "Modo desarrollador"
3. Haz clic en "Cargar extensión sin empaquetar"
4. Selecciona la carpeta del proyecto

## Configuración

1. Haz clic en el ícono de la extensión
2. Ingresa la URL de tu Odoo (ej: `https://tuempresa.odoo.com`)
3. Guarda la configuración

La extensión usará la sesión activa de Odoo en el navegador para autenticarse.

## Modelos de Odoo utilizados

| Modelo | Propósito |
|--------|-----------|
| `res.partner` | Contacto principal |
| `sale.order` | Suscripciones/pedidos del cliente |
| `account.move` | Facturas para cálculo de deuda |
| `project.task` | Tareas relacionadas |
| `helpdesk.ticket` | Tickets de soporte |
| `x_detalle_de_ticket` | Tickets NOC personalizados |

## Campos personalizados (Studio)

| Campo | Modelo | Relación |
|-------|--------|----------|
| `x_studio_subscription_id` | `account.move` | `sale.order` |
| `x_studio_partner_shipping_id` | `project.task`, `helpdesk.ticket`, `x_detalle_de_ticket` | `res.partner` |
| `x_studio_partner_id` | `x_detalle_de_ticket` | `res.partner` |
| `x_studio_helpdesk_id` | `x_detalle_de_ticket` | `helpdesk.ticket` |
| `x_name` | `x_detalle_de_ticket` | - |
| `x_studio_stage_id` | `x_detalle_de_ticket` | Etapa |
| `x_studio_fecha_operacion` | `x_detalle_de_ticket` | Fecha |

## Stack técnico

- JavaScript vanilla (sin frameworks)
- Chrome Extensions API (MV3)
- Comunicación con Odoo vía JSON-RPC (`/web/dataset/call_kw`)
- Service Worker para las peticiones后台
- Content Script para inyección en la página de uContact
