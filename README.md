# uContact ↔ Odoo Integration

Extensión de Chrome que integra la telefonia uContact con Odoo. Cuando un agente recibe una llamada, la extensión detecta el número en la interfaz de uContact, busca el contacto en Odoo y muestra un popup con información del cliente, sus suscripciones, deudas, tareas, tickets y NOC.

## Funcionalidades

- **Detección automática** de números telefónicos en la interfaz de uContact
- **Búsqueda en Odoo** vía JSON-RPC con patrón flexible (coincide números sin importar formato)
- **Popup al recibir la llamada** con:
  - Nombre, DNI y teléfono del cliente
  - Dirección del servicio (dirección de entrega de sus suscripciones)
  - Deuda pendiente
  - Últimas 5 facturas con su estado (clic para abrirla en Odoo)
  - Arrastrable desde la cabecera

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
| `sale.order` | Suscripciones (dirección del servicio) |
| `account.move` | Deuda y últimas facturas |

## Stack técnico

- JavaScript vanilla (sin frameworks)
- Chrome Extensions API (MV3)
- Comunicación con Odoo vía JSON-RPC (`/web/dataset/call_kw`)
- Service Worker para las peticiones后台
- Content Script para inyección en la página de uContact
