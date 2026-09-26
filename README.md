# Sistema de Pedidos WhatsApp — Carnicería Bot

Un sistema completo de punto de venta (POS) y recepción de pedidos automatizado vía WhatsApp. Diseñado originalmente para la Carnicería Raúl Oliver, el bot recibe los mensajes, utiliza Inteligencia Artificial (Groq - GPT-OSS 120B) para extraer los productos y cantidades, y los envía automáticamente a la cola de impresión del local, reflejándolos en un panel de control web en tiempo real.

## Características principales
- **Extracción por IA:** Entiende lenguaje natural y extrae el JSON del pedido automáticamente.
- **Panel Web en Tiempo Real:** Interfaz frontend (Dashboard) sincronizada mediante Server-Sent Events (SSE).
- **Gestión Avanzada de Hardware:** Motor de impresión dual con patrón estrategia. Imprime a bajo nivel en .NET para etiquetas cuadradas térmicas (Ej: Brother TD-4000) o mediante `notepad /pt` para tickets en A4 (Ej: Brother HL-1210W).
- **Control de WhatsApp desde UI:** Modal integrado para ver el estado del socket, reiniciar el servicio o solicitar un nuevo código QR sin tocar la consola.
- **Día de recogida:** tras el pedido, el cliente elige entre los 7 próximos días de apertura (sin domingos ni festivos de `festivos.json`).
- **La IA no redacta respuestas:** solo clasifica (saludo, horario, carta, pedido o relevo). Todos los textos al cliente son plantillas fijas; el horario sale de `src/schedule.js` y la carta de `productos.json`.
- **Relevo a persona:** si el bot no sabe responder, avisa al cliente y deja de contestarle hasta medianoche (o hasta pulsar "Devolver al bot" en el panel). Los pedidos dudosos se registran marcados como *Revisar*.
- **Registros:** `logs/fallos_bot.jsonl` (warnings: mensajes que el bot no resolvió) y `logs/errores.jsonl` (errores técnicos), visibles en el panel en *Incidencias* e *Información para desarrolladores*.

---

## Estructura del proyecto

```text
Gestor_pedidos_Carniceria/
├── index.js              ← Servicio principal (WhatsApp + IA + Print Engine + Express)
├── dashboard.html        ← Panel de control frontend (http://localhost:3000)
├── package.json          ← Dependencias del proyecto
├── ecosystem.config.js   ← Configuración de despliegue para PM2
├── .env                  ← Variables de entorno (crear a partir de .env.example)
├── .env.example          ← Plantilla de configuración
├── festivos.json         ← Festivos y cierres (editable sin reiniciar)
├── productos.json        ← Carta de elaborados (editable sin reiniciar)
├── src/
│   ├── config.js         ← Variables de entorno y persistencia
│   ├── schedule.js       ← Horario, días de recogida y respuestas de horario
│   ├── catalog.js        ← Carta de productos
│   └── services/         ← IA, impresión y registros de incidencias
│
│   (Se generan automáticamente en ejecución)
├── orders.json           ← Base de datos JSON de pedidos persistidos
├── config.json           ← Memoria de impresoras y perfiles de papel
├── handoffs.json         ← Clientes pasados a una persona (hasta medianoche)
├── logs/                 ← fallos_bot.jsonl y errores.jsonl
├── .wwebjs_auth/         ← Sesión encriptada de WhatsApp Web
└── node_modules/         ← Dependencias
```

---

## Instalación y despliegue

### 1. Requisitos previos
- [Node.js](https://nodejs.org/) (Versión LTS recomendada)
- Git instalado en el sistema.

### 2. Clonar el repositorio
Abre un terminal (PowerShell o CMD) y ejecuta:
```powershell
git clone https://github.com/TU_USUARIO/Gestor_pedidos_Carniceria.git
cd Gestor_pedidos_Carniceria
```

### 3. Instalar dependencias
```powershell
npm install
```

### 4. Configurar variables de entorno
Copia `.env.example` a `.env` (`copy .env.example .env`) y rellena tus datos. Necesitarás una API Key gratuita de [Groq Console](https://console.groq.com):
```env
GROQ_API_KEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
PRINTER_INTERFACE=Brother XXXXXXX
SHOP_NAME="CARNICERÍA RAÚL OLIVER"
PORT=3000
# 127.0.0.1 = solo este PC. 0.0.0.0 abre el panel a toda la red local,
# y el panel NO pide contraseña: úsalo solo en una red de confianza.
HOST=127.0.0.1
```

### 5. Primera ejecución y vinculación
```powershell
node index.js
```
1. En la consola aparecerá un código QR.
2. Abre WhatsApp en tu móvil > Dispositivos vinculados > Vincular un dispositivo.
3. Escanea el QR. Cuando leas `WhatsApp conectado`, pulsa `Ctrl + C` para detener el proceso temporalmente.

### 6. Puesta en producción (Arranque automático con PM2)
Para que el bot funcione siempre en segundo plano y se levante solo al encender el PC:
```powershell
npm install -g pm2 pm2-windows-startup
pm2-windows-startup install
pm2 start ecosystem.config.js
pm2 save
```
¡El sistema ya es completamente autónomo!

---

## Uso del Panel de Control (Dashboard)
Abre tu navegador en: **http://localhost:3000**

Desde esta interfaz de administrador puedes:
- Monitorizar la entrada de nuevos pedidos con alertas sonoras.
- Marcar comandas como **Listo** o **Recogido**.
- Utilizar el **botón de reimpresión** individual para cada ticket si la máquina falla o se queda sin papel.
- Abrir el **Modal de Impresora** en la cabecera para cambiar al vuelo entre la máquina térmica y la impresora láser, asignándoles perfiles de papel (`Etiqueta 76x76` o `Folio A4`).
- Abrir el **Modal de WhatsApp** para desvincular la sesión o reiniciar el socket si hay problemas de conexión.

---

## Flujo del Sistema
```text
Cliente (WhatsApp) 
  ↳ Filtro Regex local (ignora mensajes no comerciales)
    ↳ Groq API (Modelo openai/gpt-oss-120b: Pasa texto a JSON)
      ↳ Backend Node.js (Guarda y emite evento SSE)
        ├── Impresora Local (Motor PowerShell/.NET Raw)
        ├── Panel Web (Actualiza el DOM en vivo)
        └── WhatsApp (Responde al cliente con su PIN de recogida)
```

---

## Mantenimiento anual
- **Festivos:** los festivos locales de Lora del Río se publican en el BOJA hacia octubre. Añádelos a `festivos.json`; el panel de desarrolladores avisa si faltan los del año en curso.
- **Vacaciones o cierres puntuales:** añádelos en `cierres` dentro de `festivos.json`.

---

## Mantenimiento y Comandos Útiles
Si necesitas gestionar el servicio en segundo plano, abre PowerShell:
```powershell
pm2 status                  # Ver estado general del bot
pm2 logs carniceria-bot     # Ver registro de eventos y errores en tiempo real
pm2 restart carniceria-bot  # Reiniciar el sistema
```

---

## Autor
Desarrollado por **Francisco Javier Párraga Oliver**  
*Full-Stack Software Developer*