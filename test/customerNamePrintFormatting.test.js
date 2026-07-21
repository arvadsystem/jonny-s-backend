import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVentaTicketPdfBuffer,
  buildVentaTicketPdfDefinition,
  mmToPt
} from '../routers/ventas/services/ventaTicketPdfService.js';
import { buildComandaCocinaHtml } from '../services/comandaCocinaHtmlService.js';
import {
  MAX_CANONICAL_HTML_BYTES,
  MAX_CANONICAL_PDF_BYTES
} from '../services/printJobDocumentService.js';

const SHORT_CUSTOMER_NAME = 'Ana Lopez';
const LONG_CUSTOMER_NAME = 'Maria Fernanda Hernandez Rodriguez de Martinez con apellido adicional';
const LONG_UNBROKEN_CUSTOMER_NAME = `Cliente ${'ExtraordinariamenteLargo'.repeat(4)}`;
const STRESS_CUSTOMER_NAME = `Cliente ${'ExtraordinariamenteLargo'.repeat(10)}`;

const buildFactura = (widthMm, customerName) => ({
  id_factura: 501,
  codigo_venta: 'VTA-00501',
  fecha_hora_facturacion: '2026-07-20T18:34:00.000Z',
  nombre_sucursal: 'El Carmen',
  nombre_caja: 'Caja Principal',
  id_sesion_caja: 9001,
  nombre_usuario: 'Ana Cajera',
  cliente_nombre: customerName,
  cliente_rtn: '08011999123456',
  metodo_pago: 'Efectivo',
  sub_total: 120,
  total: 120,
  items: [{ cantidad: 1, nombre_item: 'Combo Jonny', total_linea: 120 }],
  facturacion: {
    emisor: { nombre_emisor: "JONNY'S WINGS" },
    ticket: {
      ancho_ticket_mm: widthMm,
      mostrar_logo_ticket: false,
      mostrar_datos_fiscales: false,
      mostrar_codigo_interno_ticket: true,
      mostrar_impuestos_ticket: false
    },
    fiscal: { habilitado: false }
  }
});

const buildComanda = (customerName) => ({
  id_pedido: 701,
  numero_pedido: 'PED-00701',
  fecha_hora_pedido: '2026-07-20T18:34:00.000Z',
  nombre_sucursal: 'El Carmen',
  nombre_usuario: 'Ana Cajera',
  modalidad: 'CONSUMO_LOCAL',
  mesa_nombre: 'Mesa 4',
  cliente_nombre: customerName,
  contacto: { telefono_contacto: '9999-0007' },
  items: [{ cantidad: 1, nombre_item: 'Combo Jonny' }]
});

const collectPdfTextNodes = (value, result = []) => {
  if (Array.isArray(value)) {
    for (const entry of value) collectPdfTextNodes(entry, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  if (value.text !== undefined) result.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'text') collectPdfTextNodes(child, result);
  }
  return result;
};

const extractCustomerCss = (html) => html.match(
  /\.comanda-cocina-print__customer-name\s*\{([\s\S]*?)\n\s*\}/
)?.[1] || '';

for (const [widthMm, expectedFontSize] of [[58, 12.4], [80, 14]]) {
  for (const customerName of [SHORT_CUSTOMER_NAME, LONG_CUSTOMER_NAME, LONG_UNBROKEN_CUSTOMER_NAME]) {
    test(`factura ${widthMm} mm imprime cliente actual a ${expectedFontSize} pt: ${customerName.length} caracteres`, async () => {
      const factura = buildFactura(widthMm, customerName);
      const definition = buildVentaTicketPdfDefinition(factura);
      const textNodes = collectPdfTextNodes(definition.content);
      const customerNode = textNodes.find((node) => node.text === customerName);
      const customerIndex = textNodes.indexOf(customerNode);
      const nextSectionIndex = textNodes.findIndex((node) => node.text === 'RTN cliente');

      assert.ok(customerNode);
      assert.equal(customerNode.bold, true);
      assert.equal(customerNode.fontSize, expectedFontSize);
      assert.equal(customerNode.lineHeight, 1.2);
      assert.deepEqual(customerNode.margin, [0, 1, 0, 4]);
      assert.equal(customerNode.width, undefined);
      assert.ok(nextSectionIndex > customerIndex);
      assert.equal(definition.pageSize.width, mmToPt(widthMm));

      const pdf = await buildVentaTicketPdfBuffer(factura);
      assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
      assert.ok(pdf.length < MAX_CANONICAL_PDF_BYTES);
    });
  }

  test(`factura ${widthMm} mm reserva mas altura para un cliente largo`, () => {
    const shortDefinition = buildVentaTicketPdfDefinition(buildFactura(widthMm, SHORT_CUSTOMER_NAME));
    const longDefinition = buildVentaTicketPdfDefinition(buildFactura(widthMm, STRESS_CUSTOMER_NAME));
    assert.ok(longDefinition.pageSize.height > shortDefinition.pageSize.height);
  });
}

for (const [widthMm, expectedFontSize] of [[58, 21], [80, 22]]) {
  for (const customerName of [SHORT_CUSTOMER_NAME, LONG_CUSTOMER_NAME, LONG_UNBROKEN_CUSTOMER_NAME]) {
    test(`comanda ${widthMm} mm imprime cliente actual a ${expectedFontSize} px: ${customerName.length} caracteres`, () => {
      const html = buildComandaCocinaHtml(buildComanda(customerName), { widthMm });
      const customerCss = extractCustomerCss(html);
      const customerIndex = html.indexOf(customerName);
      const phoneIndex = html.indexOf('Telefono');

      assert.match(html, /class="comanda-cocina-print__customer"/);
      assert.match(html, /class="comanda-cocina-print__customer-label">Cliente<\/span>/);
      assert.match(html, new RegExp(`font-size:\\s*${expectedFontSize}px`));
      assert.match(customerCss, /font-weight:\s*800/);
      assert.match(customerCss, /line-height:\s*1\.2/);
      assert.match(customerCss, /white-space:\s*normal/);
      assert.match(customerCss, /overflow-wrap:\s*anywhere/);
      assert.match(customerCss, /word-break:\s*break-word/);
      assert.doesNotMatch(customerCss, /position:\s*absolute|(?:^|\s)height:\s*\d|overflow:\s*hidden/);
      assert.ok(phoneIndex > customerIndex);
      assert.ok(Buffer.byteLength(html, 'utf8') < MAX_CANONICAL_HTML_BYTES);
    });
  }
}

test('los renderers actuales conservan sus fallbacks cuando no hay nombre', () => {
  const pdfNodes = collectPdfTextNodes(buildVentaTicketPdfDefinition(buildFactura(58, null)).content);
  assert.ok(pdfNodes.some((node) => node.text === 'Consumidor final' && node.fontSize === 12.4));

  const html = buildComandaCocinaHtml(buildComanda(null), { widthMm: 58 });
  assert.match(html, /class="comanda-cocina-print__customer-name">N\/D<\/strong>/);
});

test('legacy conserva la fila estrecha y no incorpora las clases nuevas', () => {
  const facturaLegacy = buildVentaTicketPdfDefinition(buildFactura(80, LONG_CUSTOMER_NAME), { legacy: true });
  const customerLegacy = collectPdfTextNodes(facturaLegacy.content).find((node) => node.text === LONG_CUSTOMER_NAME);
  assert.equal(customerLegacy.fontSize, undefined);
  assert.equal(customerLegacy.alignment, 'right');

  const comandaLegacy = buildComandaCocinaHtml(buildComanda(LONG_CUSTOMER_NAME), { widthMm: 80, legacy: true });
  assert.doesNotMatch(comandaLegacy, /comanda-cocina-print__customer(?:-name|-label|\")/);
  assert.match(comandaLegacy, /<span>Cliente<\/span>\s*<span>Maria Fernanda/);
});
