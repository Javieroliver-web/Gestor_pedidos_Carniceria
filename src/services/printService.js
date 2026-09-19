'use strict';
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { getPrinterName, getCurrentPrinter, getProfiles, SHOP_NAME } = require('../config');

async function printTicket(order, pin) {
  const printerName = getPrinterName(getCurrentPrinter());
  if (!printerName) throw new Error('No hay ninguna impresora configurada.');

  const profiles = getProfiles();
  const profile = profiles[printerName] || 'label_square';

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

  if (order.cliente && order.cliente.toLowerCase() !== 'cliente') {
    ticketText += ` Cliente: ${order.cliente}\n`;
  }
  if (order.hora && String(order.hora).toLowerCase() !== 'null') {
    ticketText += ` HORA RECOGIDA: ${order.hora}\n`;
  }
  if ((order.cliente && order.cliente.toLowerCase() !== 'cliente') || (order.hora && String(order.hora).toLowerCase() !== 'null')) {
    ticketText += `${separator}\n`;
  }

  for (const item of order.articulos) {
    const cant = (item.cantidad || '').padEnd(10, ' ');
    ticketText += ` * ${cant} ${item.producto}\n`;
  }
  ticketText += `${separator}\n   Indica tu PIN en mostrador.`;

  const tempFilePath = path.join(__dirname, '..', '..', `ticket_${pin}_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tempFilePath, ticketText, 'utf8');
    const psScript = `
      $printerName = '${printerName}';
      $filePath = '${tempFilePath.replace(/\\/g, '\\\\')}';
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
    await execPromise(`powershell -NoProfile -EncodedCommand ${encodedCommand}`, { timeout: 15000 });
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

  if (order.cliente && order.cliente.toLowerCase() !== 'cliente') {
    ticketText += `   Cliente: ${order.cliente}\n`;
  }
  if (order.hora && String(order.hora).toLowerCase() !== 'null') {
    ticketText += `   HORA RECOGIDA: ${order.hora}\n`;
  }
  ticketText += `   ${subSeparator}\n\n`;

  for (const item of order.articulos) {
    const cant = (item.cantidad || '').padEnd(12, ' ');
    ticketText += `   ${cant} ${item.producto}\n`;
  }
  ticketText += `\n   ${separator}\n   Gracias por su confianza.\n\n\n`;

  const tempFilePath = path.join(__dirname, '..', '..', `ticket_${pin}_A4_${Date.now()}.txt`);
  try {
    fs.writeFileSync(tempFilePath, '\ufeff' + ticketText, 'utf8');
    await execPromise(`notepad.exe /pt "${tempFilePath}" "${printerName}"`, { timeout: 20000 });
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