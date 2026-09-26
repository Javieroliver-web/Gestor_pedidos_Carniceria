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

  const tempFilePath = path.join(__dirname, '..', '..', `ticket_${pin}_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tempFilePath, ticketText, 'utf8');
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
          $font = New-Object System.Drawing.Font('Consolas', 10);
          $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black);
          $e.Graphics.DrawString($content, $font, $brush, 0, 0);
      }.GetNewClosure());
      $printDocument.Print();
    `;
    const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
    await execFilePromise('powershell', ['-NoProfile', '-EncodedCommand', encodedCommand], {
      timeout: 15000,
      env: { ...process.env, CARN_PRINTER: printerName, CARN_TICKET: tempFilePath },
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

module.exports = { printTicket, listWindowsPrinters };