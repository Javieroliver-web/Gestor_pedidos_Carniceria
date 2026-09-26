'use strict';
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const { getPrinterName, getCurrentPrinter, getProfiles, SHOP_NAME } = require('../config');

// opts.printerName / opts.profile permiten imprimir en otra impresora (p. ej. test)
// sin tocar el estado global, que podría estar usando un pedido real en paralelo.
async function printTicket(order, pin, opts = {}) {
  const printerName = getPrinterName(opts.printerName ?? getCurrentPrinter());
  if (!printerName) throw new Error('No hay ninguna impresora configurada.');

  const profile = opts.profile || getProfiles()[printerName] || 'label_square';

  if (profile === 'a4_paper') {
    await printA4(order, pin, printerName);
  } else {
    await printSquareLabel(order, pin, printerName);
  }
}

// La etiqueta es de 76x76 mm. Con Consolas 10 pt caben ~34 caracteres por línea y ~17 líneas.
// Si el pedido es largo se parte en líneas y se reduce la letra (hasta 6 pt) para que no se corte.
function fitLabel(text) {
  const BASE_SIZE = 10, BASE_COLS = 34, BASE_ROWS = 17, MIN_SIZE = 6;
  const wrap = (cols) => text.split('\n').flatMap(line => {
    if (line.length <= cols) return [line];
    const out = [];
    const lead = line.match(/^\s*/)[0];
    const indent = lead + '    ';
    const words = line.trim().split(/ +/);
    let cur = lead + words.shift();
    for (const word of words) {
      if ((cur + ' ' + word).length > cols) { out.push(cur); cur = indent + word; }
      else cur += ' ' + word;
    }
    if (cur.trim()) out.push(cur.trimEnd());
    return out;
  });
  for (let size = BASE_SIZE; size >= MIN_SIZE; size--) {
    const cols = Math.floor(BASE_COLS * BASE_SIZE / size), rows = Math.floor(BASE_ROWS * BASE_SIZE / size);
    const lines = wrap(cols);
    if (lines.length <= rows) return { text: lines.join('\n'), size };
  }
  // Ni a 6 pt cabe: se imprime lo que quepa y se avisa de que el resto está en el panel.
  const cols = Math.floor(BASE_COLS * BASE_SIZE / MIN_SIZE), rows = Math.floor(BASE_ROWS * BASE_SIZE / MIN_SIZE);
  const lines = wrap(cols);
  const kept = lines.slice(0, rows - 1);
  kept.push(` ...(+${lines.length - kept.length} lineas: ver panel)`);
  return { text: kept.join('\n'), size: MIN_SIZE };
}

async function printSquareLabel(order, pin, printerName) {
  const now = new Date();
  const fecha = now.toLocaleDateString('es-ES');
  const hora = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const separator = ' - - - - - - - - - - - - - - - - ';

  let ticketText = `   CARNICERIA RAUL OLIVER\n${separator}\n      PIN DE PEDIDO: ${pin}\n   Fecha: ${fecha}  ${hora}\n${separator}\n`;

  if (order.revisar) ticketText += ` *** REVISAR CON EL CLIENTE ***\n`;
  if (order.cliente && order.cliente.toLowerCase() !== 'cliente') ticketText += ` Cliente: ${order.cliente}\n`;
  ticketText += ` RECOGIDA: ${order.diaCorto || 'SIN DIA'}\n${separator}\n`;

  for (const item of order.articulos) {
    const cant = (item.cantidad || '??').padEnd(10, ' ');
    ticketText += ` * ${cant} ${item.producto}${item.dudoso ? ' (?)' : ''}\n`;
  }
  ticketText += `${separator}\n   Indica tu PIN en mostrador.`;

  const fitted = fitLabel(ticketText);
  const tempFilePath = path.join(__dirname, '..', '..', `ticket_${pin}_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tempFilePath, fitted.text, 'utf8');
    // Nombre de impresora y ruta se pasan por variables de entorno, nunca interpolados
    // en el script: una comilla en el nombre permitía ejecutar PowerShell arbitrario.
    const psScript = `
      $printerName = $env:CARN_PRINTER;
      $filePath = $env:CARN_TICKET;
      $content = Get-Content -Path $filePath -Raw -Encoding UTF8;
      Add-Type -AssemblyName System.Drawing;
      $printDocument = New-Object System.Drawing.Printing.PrintDocument;
      $printDocument.PrinterSettings.PrinterName = $printerName;
      if (-not $printDocument.PrinterSettings.IsValid) { throw "La impresora '$printerName' no es válida."; }
      $pageSettings = New-Object System.Drawing.Printing.PageSettings;
      $customSize = New-Object System.Drawing.Printing.PaperSize('Custom-76x76', 299, 299);
      $pageSettings.PaperSize = $customSize;
      $pageSettings.Margins = New-Object System.Drawing.Printing.Margins(10, 10, 10, 10);
      $printDocument.DefaultPageSettings = $pageSettings;
      $printDocument.add_PrintPage({
          param($sender, $e)
          $font = New-Object System.Drawing.Font('Consolas', [single]$env:CARN_FONT);
          $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black);
          $e.Graphics.DrawString($content, $font, $brush, 0, 0);
      }.GetNewClosure());
      $printDocument.Print();
    `;
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
    await execFilePromise('powershell', ['-NoProfile', '-EncodedCommand', encodedCommand], {
      timeout: 15000,
      env: { ...process.env, CARN_PRINTER: printerName, CARN_TICKET: tempFilePath, CARN_FONT: String(fitted.size) },
    });
  } finally {
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
  }
}

async function printA4(order, pin, printerName) {
  const now = new Date();
  const fecha = now.toLocaleDateString('es-ES');
  const hora = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const separator = '='.repeat(60);
  const subSeparator = '-'.repeat(60);

  let ticketText = `\n\n   ${SHOP_NAME}\n   Documento de Pedido / Recogida\n   ${separator}\n\n   >> CÓDIGO DE RECOGIDA (PIN): ${pin} <<\n\n   ${separator}\n   Fecha: ${fecha}      Hora: ${hora}\n`;

  if (order.revisar) ticketText += `   *** REVISAR CON EL CLIENTE: ${order.motivoRevision || ''} ***\n`;
  if (order.cliente && order.cliente.toLowerCase() !== 'cliente') {
    ticketText += `   Cliente: ${order.cliente}\n`;
  }
  ticketText += `   DÍA DE RECOGIDA: ${order.diaLargo || order.diaCorto || 'SIN DÍA'}\n`;
  ticketText += `   ${subSeparator}\n\n`;

  for (const item of order.articulos) {
    const cant = (item.cantidad || '??').padEnd(12, ' ');
    ticketText += `   ${cant} ${item.producto}${item.dudoso ? ' (?)' : ''}\n`;
  }
  ticketText += `\n   ${separator}\n   Gracias por su confianza.\n\n\n`;

  const tempFilePath = path.join(__dirname, '..', '..', `ticket_${pin}_A4_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tempFilePath, '\ufeff' + ticketText, 'utf8');
    // execFile sin shell: el nombre de impresora va como argumento, no concatenado en un comando.
    await execFilePromise('notepad.exe', ['/pt', tempFilePath, printerName], { timeout: 20000 });
  } finally {
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
  }
}

function listWindowsPrinters() {
  return new Promise(resolve => {
    const cmd = 'powershell -NoProfile -Command "@(Get-Printer | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress"';
    exec(cmd, { timeout: 6000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch { resolve([]); }
    });
  });
}

module.exports = { printTicket, listWindowsPrinters, _fitLabel: fitLabel };