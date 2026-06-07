import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pdfmake from 'pdfmake';

const FONT_DIR = fileURLToPath(new URL('../../../node_modules/pdfmake/fonts/Roboto/', import.meta.url));
const FONT_DIR_PREFIX = path.resolve(FONT_DIR) + path.sep;
const DEFAULT_FOOTER = 'Gracias por su compra';

pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((filePath) => path.resolve(filePath).startsWith(FONT_DIR_PREFIX));
pdfmake.setFonts({
  Roboto: {
    normal: path.join(FONT_DIR, 'Roboto-Regular.ttf'),
    bold: path.join(FONT_DIR, 'Roboto-Medium.ttf'),
    italics: path.join(FONT_DIR, 'Roboto-Italic.ttf'),
    bolditalics: path.join(FONT_DIR, 'Roboto-MediumItalic.ttf')
  }
});

export const mmToPt = (mm) => (mm * 72) / 25.4;

const toMoneyNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatMoney = (value) =>
  `L ${toMoneyNumber(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

const cleanText = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
};

const formatDateParts = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return { date: '--', time: '--' };

  return {
    date: date.toLocaleDateString('es-HN', {
      timeZone: 'America/Tegucigalpa',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }),
    time: date.toLocaleTimeString('es-HN', {
      timeZone: 'America/Tegucigalpa',
      hour: '2-digit',
      minute: '2-digit'
    })
  };
};

const resolveTicketWidth = (venta = {}) =>
  Number(venta?.facturacion?.ticket?.ancho_ticket_mm || venta?.ancho_ticket_mm) === 58 ? 58 : 80;

const isPdfSupportedImageDataUrl = (value) =>
  /^data:image\/(?:png|jpe?g);base64,/i.test(String(value || ''));

const countExtras = (items = []) =>
  items.reduce((sum, item) => sum + (Array.isArray(item?.extras) ? item.extras.length : 0), 0);

const countSplitLines = (cuentaDividida) => {
  const divisiones = Array.isArray(cuentaDividida?.divisiones) ? cuentaDividida.divisiones : [];
  return divisiones.reduce((sum, division) => (
    sum + 1 + (Array.isArray(division?.items) ? division.items.length : 0)
  ), 0);
};

const estimateHeightMm = (venta = {}) => {
  const items = Array.isArray(venta.items) ? venta.items : [];
  const extrasCount = countExtras(items);
  const splitCount = countSplitLines(venta.cuenta_dividida);
  const fiscalBlocks = venta?.facturacion?.ticket?.mostrar_datos_fiscales === false ? 0 : 4;
  const logoBlock = venta?.facturacion?.ticket?.mostrar_logo_ticket && venta?.facturacion?.emisor?.logo_data_url ? 18 : 0;
  const deliveryBlock = venta?.delivery ? 16 : 0;
  const estimated = 110
    + logoBlock
    + items.length * 10
    + extrasCount * 5
    + splitCount * 7
    + fiscalBlocks * 4
    + deliveryBlock;

  return Math.max(160, estimated);
};

const text = (value, options = {}) => ({
  text: cleanText(value) || '--',
  ...options
});

const divider = () => ({
  canvas: [
    { type: 'line', x1: 0, y1: 0, x2: 170, y2: 0, lineWidth: 0.4, dash: { length: 2, space: 2 } }
  ],
  margin: [0, 4, 0, 4]
});

const metaRow = (label, value) => ({
  columns: [
    text(label, { width: 58, bold: true }),
    text(value, { width: '*', alignment: 'right' })
  ],
  columnGap: 4,
  margin: [0, 1, 0, 1]
});

const buildHeader = (venta, widthMm) => {
  const facturacion = venta.facturacion || {};
  const emisor = facturacion.emisor || {};
  const ticket = facturacion.ticket || {};
  const content = [];

  if (ticket.mostrar_logo_ticket && isPdfSupportedImageDataUrl(emisor.logo_data_url)) {
    content.push({
      image: emisor.logo_data_url,
      width: widthMm === 58 ? 60 : 78,
      alignment: 'center',
      margin: [0, 0, 0, 4]
    });
  }

  content.push(text(emisor.nombre_emisor || venta.nombre_emisor || "JONNY'S", {
    alignment: 'center',
    bold: true,
    fontSize: widthMm === 58 ? 9 : 10
  }));

  if (ticket.texto_encabezado_ticket) {
    content.push(text(ticket.texto_encabezado_ticket, { alignment: 'center', margin: [0, 2, 0, 2] }));
  }

  if (ticket.mostrar_rtn && emisor.rtn_emisor) content.push(text(`RTN: ${emisor.rtn_emisor}`, { alignment: 'center' }));
  if (ticket.mostrar_direccion && emisor.direccion_emisor) content.push(text(emisor.direccion_emisor, { alignment: 'center' }));
  if (ticket.mostrar_telefono && emisor.telefono_emisor) content.push(text(`Tel: ${emisor.telefono_emisor}`, { alignment: 'center' }));
  if (ticket.mostrar_correo && emisor.correo_emisor) content.push(text(emisor.correo_emisor, { alignment: 'center' }));

  return content;
};

const buildFiscalBlock = (venta) => {
  const facturacion = venta.facturacion || {};
  const ticket = facturacion.ticket || {};
  const fiscal = facturacion.fiscal || {};
  if (ticket.mostrar_datos_fiscales === false) return [];

  const rows = [];
  if (ticket.mostrar_cai_ticket) rows.push(metaRow('CAI', fiscal.cai || venta.cai || '0'));
  if (ticket.mostrar_numero_fiscal_ticket) {
    rows.push(metaRow('No fiscal', fiscal.numero_factura_fiscal || venta.numero_factura_fiscal || '0'));
  }
  if (ticket.mostrar_codigo_interno_ticket) {
    rows.push(metaRow('Codigo', venta.codigo_venta || venta.numero_venta || `VTA-${String(venta.id_factura || '').padStart(5, '0')}`));
  }

  return rows.length ? [divider(), ...rows] : [];
};

const buildMetaBlock = (venta) => {
  const parts = formatDateParts(venta.fecha_hora_facturacion || venta.fecha_hora_pedido);
  const rows = [
    metaRow('Fecha', parts.date),
    metaRow('Hora', parts.time),
    metaRow('Sucursal', venta.nombre_sucursal || venta.sucursal || '--'),
    metaRow('Caja', venta.nombre_caja || venta.codigo_caja || '--'),
    metaRow('Sesion', venta.id_sesion_caja ? `#${venta.id_sesion_caja}` : '--'),
    metaRow('Cajero', venta.nombre_usuario || '--'),
    metaRow('Cliente', venta.cliente_nombre || 'Consumidor final')
  ];

  if (venta.cliente_rtn) rows.push(metaRow('RTN cliente', venta.cliente_rtn));
  if (venta.metodo_pago) rows.push(metaRow('Pago', venta.metodo_pago));

  return [divider(), ...rows];
};

const buildItemRows = (items = [], widthMm) => {
  const rows = [[
    text('Cant', { bold: true }),
    text('Detalle', { bold: true }),
    text('Total', { bold: true, alignment: 'right' })
  ]];

  for (const item of items) {
    rows.push([
      text(item.cantidad || 1),
      text(item.nombre_item || item.nombre_producto || 'Item'),
      text(formatMoney(item.total_linea || item.sub_total), { alignment: 'right' })
    ]);

    if (Array.isArray(item.extras)) {
      for (const extra of item.extras) {
        rows.push([
          text(''),
          text(`+ ${extra.nombre || extra.nombre_extra || 'Extra'} x${extra.cantidad || 1}`, { fontSize: widthMm === 58 ? 5.5 : 6 }),
          text(formatMoney(extra.subtotal || (toMoneyNumber(extra.precio_unitario) * toMoneyNumber(extra.cantidad || 1))), {
            alignment: 'right',
            fontSize: widthMm === 58 ? 5.5 : 6
          })
        ]);
      }
    }
  }

  return rows;
};

const buildItemsBlock = (venta, widthMm) => {
  const items = Array.isArray(venta.items) ? venta.items : [];
  return [
    divider(),
    text('ITEMS', { bold: true, alignment: 'center', margin: [0, 0, 0, 2] }),
    {
      table: {
        widths: [widthMm === 58 ? 20 : 24, '*', widthMm === 58 ? 38 : 48],
        body: buildItemRows(items, widthMm)
      },
      layout: 'lightHorizontalLines'
    }
  ];
};

const buildSplitBlock = (cuentaDividida) => {
  const divisiones = Array.isArray(cuentaDividida?.divisiones) ? cuentaDividida.divisiones : [];
  if (!divisiones.length) return [];

  const content = [divider(), text('CUENTA DIVIDIDA', { bold: true, alignment: 'center' })];
  for (const division of divisiones) {
    content.push(metaRow(division.etiqueta || 'Persona', formatMoney(division.total)));
    for (const item of Array.isArray(division.items) ? division.items : []) {
      content.push(text(`  ${item.nombre_item || 'Item'} x${item.cantidad || 1}`, { fontSize: 6 }));
    }
  }
  return content;
};

const buildTotalsBlock = (venta) => {
  const ticket = venta?.facturacion?.ticket || {};
  const rows = [divider()];
  rows.push(metaRow('Subtotal', formatMoney(venta.sub_total)));

  const descuento = toMoneyNumber(venta.descuento_total || venta.descuento);
  if (descuento > 0 && ticket.mostrar_descuento_total !== false) {
    rows.push(metaRow('Descuento', `-${formatMoney(descuento)}`));
  }

  if (ticket.mostrar_impuestos_ticket) {
    if (ticket.mostrar_importe_exento) rows.push(metaRow('Exento', formatMoney(venta.exento)));
    if (ticket.mostrar_importe_gravado_15) rows.push(metaRow('Gravado 15', formatMoney(venta.gravado_15)));
    if (ticket.mostrar_isv_15) rows.push(metaRow('ISV 15', formatMoney(venta.isv_15)));
    if (ticket.mostrar_importe_gravado_18) rows.push(metaRow('Gravado 18', formatMoney(venta.gravado_18)));
    if (ticket.mostrar_isv_18) rows.push(metaRow('ISV 18', formatMoney(venta.isv_18)));
    if (ticket.mostrar_total_isv) rows.push(metaRow('Total ISV', formatMoney(venta.total_isv)));
  }

  rows.push(metaRow('TOTAL', formatMoney(venta.total)));

  if (toMoneyNumber(venta.efectivo_entregado) > 0) rows.push(metaRow('Efectivo', formatMoney(venta.efectivo_entregado)));
  if (toMoneyNumber(venta.cambio) > 0) rows.push(metaRow('Cambio', formatMoney(venta.cambio)));

  return rows;
};

const buildDeliveryBlock = (venta) => {
  if (!venta.delivery) return [];
  return [
    divider(),
    text('ENTREGA', { bold: true, alignment: 'center' }),
    metaRow('Receptor', venta.delivery.nombre_receptor || '--'),
    metaRow('Telefono', venta.delivery.telefono_receptor || '--'),
    metaRow('Direccion', venta.delivery.direccion_entrega || '--')
  ];
};

export const buildVentaTicketPdfBuffer = async (venta) => {
  const widthMm = resolveTicketWidth(venta);
  const heightMm = estimateHeightMm(venta);
  const ticket = venta?.facturacion?.ticket || {};
  const content = [
    ...buildHeader(venta, widthMm),
    ...buildFiscalBlock(venta),
    ...buildMetaBlock(venta),
    ...buildItemsBlock(venta, widthMm),
    ...buildSplitBlock(venta.cuenta_dividida),
    ...buildDeliveryBlock(venta),
    ...buildTotalsBlock(venta),
    divider(),
    text(ticket.texto_pie_ticket || DEFAULT_FOOTER, { alignment: 'center', margin: [0, 2, 0, 0] })
  ];

  const docDefinition = {
    pageSize: {
      width: mmToPt(widthMm),
      height: mmToPt(heightMm)
    },
    pageMargins: [mmToPt(3), mmToPt(4), mmToPt(3), mmToPt(4)],
    defaultStyle: {
      font: 'Roboto',
      fontSize: widthMm === 58 ? 6.5 : 7.5
    },
    styles: {},
    content
  };

  return pdfmake.createPdf(docDefinition).getBuffer();
};

export const buildVentaTicketPdfFilename = (venta = {}) => {
  const raw = cleanText(venta.codigo_venta || venta.numero_venta || `VTA-${String(venta.id_factura || '').padStart(5, '0')}`);
  const safe = raw.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || `VTA-${venta.id_factura || 'ticket'}`;
  return `ticket-${safe}.pdf`;
};
