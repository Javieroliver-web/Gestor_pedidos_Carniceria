# Sistema de Pedidos WhatsApp — Carnicería
## Archivos del proyecto

```
C:\Gestor_pedidos_Carniceria\
├── index.js              ← Servicio principal (WhatsApp + IA + impresora + web)
├── dashboard.html        ← Panel de pedidos (http://localhost:3000)
├── package.json          ← Dependencias npm
├── ecosystem.config.js   ← Configuración de PM2
├── .env                  ← Variables de entorno (crear a partir de .env.example)
├── .env.example          ← Plantilla de configuración
│
│   (se crean automáticamente al ejecutar)
├── orders.json           ← Pedidos persistidos
├── config.json           ← Impresora seleccionada desde el panel
├── .wwebjs_auth/         ← Sesión de WhatsApp (tras escanear el QR)
└── node_modules/         ← Dependencias instaladas (tras npm install)
```

---

## Instalación rápida

### 1. Instalar Node.js
Descargar e instalar la versión LTS desde https://nodejs.org

### 2. Crear la carpeta y copiar los archivos
Abrir **cmd como Administrador**:
```cmd
mkdir C:\Gestor_pedidos_Carniceria
cd C:\Gestor_pedidos_Carniceria
```
Copiar todos los archivos del proyecto en esta carpeta.

### 3. Instalar dependencias
```cmd
npm install
```

### 4. Crear el archivo .env
```cmd
copy .env.example .env
notepad .env
```
Rellenar:
```
ANTHROPIC_API_KEY=sk-ant-XXXXXXXXXXXXXXXX
PRINTER_INTERFACE=printer:Tickets
SHOP_NAME=CARNICERÍA RAUL OLIVER
```

### 5. Configurar la impresora térmica (USB)
1. Conectar la impresora — Windows instala el driver automáticamente
2. Configuración → Bluetooth y dispositivos → Impresoras
3. Clic en la impresora → Propiedades → pestaña Compartir
4. Activar "Compartir esta impresora", nombre de recurso: `Tickets`

### 6. Primera ejecución — escanear el QR
```cmd
node index.js
```
Escanear el QR con WhatsApp (Dispositivos vinculados → Vincular un dispositivo).
Este paso solo se hace una vez. Cuando aparezca "Sistema activo", pulsar Ctrl+C.

### 7. Instalar PM2 y activar el arranque automático
```cmd
npm install -g pm2 pm2-windows-startup
pm2-windows-startup install
cd C:\carniceria-bot
pm2 start ecosystem.config.js
pm2 save
```

**A partir de aquí el sistema es completamente automático.**
El PC arranca → el servicio levanta solo → los pedidos se imprimen solos.

---

## Panel de pedidos
Abrir en el navegador: **http://localhost:3000**

Desde el panel se puede:
- Ver los pedidos en tiempo real (actualización automática por SSE)
- Marcar pedidos como **Listo** (preparado) o **Recogido**
- **Descartar** pedidos (requiere doble confirmación)
- Ver **fallos de impresión** y **reintentar** desde el panel
- **Cambiar la impresora** desde el botón de cabecera sin reiniciar el servicio

---

## Flujo del sistema
```
Cliente → WhatsApp → Filtro regex → Claude IA → Impresora (ticket automático)
                                              → WhatsApp (confirmación con PIN)
                                              → Panel web (tarjeta en tiempo real)
```

---

## Comandos de mantenimiento
```cmd
pm2 status                   → estado del servicio
pm2 logs carniceria-bot      → logs en tiempo real
pm2 restart carniceria-bot   → reiniciar
pm2 stop carniceria-bot      → parar
```

---

## Solución de problemas

| Problema | Solución |
|---|---|
| Error al imprimir | Verificar impresora encendida. Cambiar desde el panel (botón impresora en cabecera) |
| QR expirado | Ejecutar `node index.js` de nuevo |
| WhatsApp desconectado | PM2 reinicia automáticamente. Si persiste: borrar `.wwebjs_auth` y repetir paso 6 |
| Servicio no arranca con el PC | Ejecutar `pm2-windows-startup install` como Administrador |
| Mensajes ignorados | Revisar `pm2 logs` y ampliar palabras clave en `ORDER_RE` en `index.js` |
| El proceso aparece como `errored` | Ejecutar `pm2 logs carniceria-bot --err` para ver el error exacto |
