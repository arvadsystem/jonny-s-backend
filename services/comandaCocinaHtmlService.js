import { formatHondurasDateTime } from '../utils/hondurasDateTime.js';

const HONDURAS_TIME_ZONE = 'America/Tegucigalpa';

const resolveTicketWidthMm = (value) => Number(value) === 58 ? 58 : 80;

const resolveFacturaLikeMetrics = (ticketWidthMm) => {
  if (ticketWidthMm === 58) {
    return {
      ticketWidthMm: 58,
      marginLeftMm: 4,
      marginRightMm: 5,
      contentWidthMm: 47.5
    };
  }

  return {
    ticketWidthMm: 80,
    marginLeftMm: 7,
    marginRightMm: 10,
    contentWidthMm: 61.5
  };
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const toSafeText = (value, fallback = 'N/D') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const toSafeNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

// Formato legacy (schema_version 2): reproduce byte a byte las comandas creadas
// antes de 3eea227 (dateStyle/timeStyle short, hora 12h). Existe solo para
// regenerar de forma identica trabajos v2 ya encolados.
const formatDateTimeLegacy = (value) => {
  if (!value) return 'N/D';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return toSafeText(value, 'N/D');
  return new Intl.DateTimeFormat('es-HN', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: HONDURAS_TIME_ZONE
  }).format(date);
};

const formatDateTime = (value, { legacy = false } = {}) => (
  legacy
    ? formatDateTimeLegacy(value)
    : formatHondurasDateTime(value, toSafeText(value, 'N/D'))
);

const normalizeDetailList = (items, mapItem) => (
  Array.isArray(items) ? items : []
).map(mapItem).filter(Boolean);

const getSnapshotSalsas = (item) => {
  const componentes = item?.origen_snapshot?.componentes;
  if (Array.isArray(componentes)) return componentes;
  if (Array.isArray(componentes?.seleccion)) return componentes.seleccion;

  const complementos = item?.origen_snapshot?.complementos;
  if (Array.isArray(complementos)) return complementos;
  if (Array.isArray(complementos?.seleccion)) return complementos.seleccion;

  return [];
};

const resolveItemComplementos = (item) => {
  const directComplementos = normalizeDetailList(item?.complementos, (complemento, complementoIndex) => ({
    key: `${complemento?.id_complemento || complementoIndex}-${complementoIndex}`,
    nombre: toSafeText(complemento?.nombre, 'Salsa')
  }));
  if (directComplementos.length > 0) return directComplementos;

  const snapshotComponentes = normalizeDetailList(getSnapshotSalsas(item), (componente, componenteIndex) => ({
    key: `${componente?.id_complemento || componenteIndex}-${componenteIndex}`,
    nombre: toSafeText(componente?.nombre, 'Salsa')
  }));
  return snapshotComponentes;
};

const renderTags = (title, items = [], valueBuilder) => {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `
    <div class="comanda-cocina-print__tags">
      ${items.map((item) => `
        <div class="comanda-cocina-print__tag">
          <span class="comanda-cocina-print__tag-title">${escapeHtml(title)}:</span>
          <span>${valueBuilder(item)}</span>
        </div>
      `).join('')}
    </div>
  `;
};

const renderTagSummary = (title, items = [], valueBuilder) => {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `
    <div class="comanda-cocina-print__tags">
      <div class="comanda-cocina-print__tag">
        <span class="comanda-cocina-print__tag-title">${escapeHtml(title)}:</span>
        <span>${escapeHtml(items.map(valueBuilder).join(', '))}</span>
      </div>
    </div>
  `;
};

const normalizeComandaItems = (comanda) => normalizeDetailList(comanda?.items, (item, index) => {
  const cantidad = Math.max(1, toSafeNumber(item?.cantidad, 1));
  const nombreItem = toSafeText(item?.nombre_item || item?.nombre_producto, 'Item');
  const isStandaloneExtra = Boolean(item?.es_linea_extra_independiente || item?.origen_snapshot?.es_linea_extra_independiente);
  const extras = isStandaloneExtra
    ? []
    : normalizeDetailList(item?.extras, (extra, extraIndex) => ({
      key: `${extra?.id_extra || extraIndex}-${extraIndex}`,
      nombre: toSafeText(extra?.nombre || extra?.nombre_extra, 'Extra'),
      cantidad: Math.max(1, toSafeNumber(extra?.cantidad, 1))
    }));
  const complementos = resolveItemComplementos(item);
  const observacion = String(item?.observacion || item?.nota_cocina || item?.nota || '').trim();
  const tipoItem = String(item?.tipo_item || '').trim().toUpperCase();
  const explicitInstruction = String(item?.instruccion_operativa || '').trim().toUpperCase();
  const instruccionOperativa = explicitInstruction === 'ENTREGAR_JUNTO_CON_EL_PEDIDO'
    ? explicitInstruction
    : explicitInstruction === 'PREPARAR'
      ? explicitInstruction
      : (tipoItem === 'PRODUCTO' && !isStandaloneExtra
          ? 'ENTREGAR_JUNTO_CON_EL_PEDIDO'
          : 'PREPARAR');

  return {
    key: `${item?.id_detalle || index}-${index}`,
    cantidad,
    nombreItem,
    extras,
    complementos,
    observacion,
    instruccionOperativa
  };
});

export const validateComandaForPrint = (comanda) => {
  const items = normalizeComandaItems(comanda);
  if (items.length === 0) {
    return {
      ok: false,
      message: 'La comanda no tiene productos para imprimir.',
      items: []
    };
  }

  return {
    ok: true,
    message: '',
    items
  };
};

export const buildComandaCocinaHtml = (comanda, options = {}) => {
  const validation = validateComandaForPrint(comanda);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const ticketWidthMm = resolveTicketWidthMm(options?.widthMm);
  const legacy = Boolean(options?.legacy);
  const operationalSections = !legacy && options?.operationalSections !== false;
  const printMetrics = resolveFacturaLikeMetrics(ticketWidthMm);
  const contentWidthMm = printMetrics.contentWidthMm;
  const marginLeftMm = printMetrics.marginLeftMm;
  const marginRightMm = printMetrics.marginRightMm;
  const isNarrowTicket = ticketWidthMm === 58;
  const baseFontPx = isNarrowTicket ? 10.5 : 11.5;
  const titleFontPx = isNarrowTicket ? 14 : 16;
  const orderFontPx = isNarrowTicket ? 13 : 14;
  const dateFontPx = isNarrowTicket ? 10.5 : 11.5;
  const metaFontPx = isNarrowTicket ? 10.5 : 11;
  const qtyFontPx = isNarrowTicket ? 15 : 17;
  const nameFontPx = isNarrowTicket ? 13.5 : 15.5;
  const tagFontPx = isNarrowTicket ? 10 : 10.8;
  const qtyWidthMm = isNarrowTicket ? 7 : 8;
  const nestedPaddingMm = isNarrowTicket ? 7 : 8;
  const metaLabelWidthMm = isNarrowTicket ? 16 : 18;
  const items = validation.items;
  const prepararItems = items.filter((item) => item.instruccionOperativa === 'PREPARAR');
  const entregaConjuntaItems = items.filter((item) => item.instruccionOperativa === 'ENTREGAR_JUNTO_CON_EL_PEDIDO');
  const fecha = formatDateTime(comanda?.fecha_hora_pedido || comanda?.fecha_hora_facturacion, { legacy });
  const numeroPedido = toSafeText(comanda?.numero_pedido || comanda?.numero_venta || comanda?.codigo_venta);
  const sucursal = toSafeText(comanda?.nombre_sucursal, 'No registrada');
  const cajero = toSafeText(comanda?.nombre_usuario, 'No registrado');
  const modalidad = toSafeText(comanda?.modalidad || comanda?.canal, 'No registrada');
  const mesa = toSafeText(
    comanda?.mesa_nombre ||
    comanda?.nombre_mesa ||
    comanda?.mesa ||
    comanda?.delivery?.mesa ||
    comanda?.contexto?.mesa,
    'N/D'
  );
  const cliente = toSafeText(comanda?.cliente_nombre || comanda?.contacto?.nombre_contacto, 'N/D');
  const telefonoCliente = toSafeText(comanda?.contacto?.telefono_contacto, '');
  const notaGeneral = String(
    comanda?.observaciones ||
    comanda?.observacion ||
    comanda?.nota_cocina ||
    comanda?.contexto?.observacion_contexto ||
    ''
  ).trim();

  return `
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Comanda cocina</title>
    <style>
      @page {
        size: ${ticketWidthMm}mm auto;
        margin: 0;
      }
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      html, body {
        margin: 0;
        padding: 0;
        width: ${ticketWidthMm}mm;
        max-width: ${ticketWidthMm}mm;
        overflow-x: hidden;
        background: #fff;
        color: #111;
        font-family: Arial, sans-serif;
      }
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .comanda-cocina-print-root {
        width: ${contentWidthMm}mm;
        max-width: ${contentWidthMm}mm;
        margin-left: ${marginLeftMm}mm;
        margin-right: ${marginRightMm}mm;
        padding: 0;
        overflow-x: hidden;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .comanda-cocina-print {
        width: 100%;
        max-width: 100%;
        font-size: ${baseFontPx}px;
        line-height: 1.28;
        font-weight: 500;
        overflow-x: hidden;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .comanda-cocina-print,
      .comanda-cocina-print * {
        max-width: 100%;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .comanda-cocina-print__header {
        text-align: center;
        margin-bottom: 5px;
      }
      .comanda-cocina-print__header h1 {
        margin: 0 0 3px;
        font-size: ${titleFontPx}px;
        font-weight: 800;
        letter-spacing: 0.06em;
      }
      .comanda-cocina-print__header strong {
        display: block;
        font-size: ${orderFontPx}px;
        margin-bottom: 3px;
      }
      .comanda-cocina-print__header span {
        display: block;
        font-size: ${dateFontPx}px;
      }
      .comanda-cocina-print__divider {
        border-top: 1px dashed #111;
        margin: 5px 0;
      }
      .comanda-cocina-print__meta {
        display: grid;
        gap: 3px;
      }
      .comanda-cocina-print__meta-row {
        display: flex;
        gap: 3px;
        align-items: flex-start;
        min-width: 0;
        max-width: 100%;
        font-size: ${metaFontPx}px;
      }
      .comanda-cocina-print__meta-row span:first-child {
        flex: 0 0 ${metaLabelWidthMm}mm;
        min-width: 0;
        max-width: ${metaLabelWidthMm}mm;
        font-weight: 700;
      }
      .comanda-cocina-print__meta-row span:last-child {
        flex: 1 1 auto;
        text-align: right;
        min-width: 0;
        max-width: 100%;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
${legacy ? '' : `      .comanda-cocina-print__customer-name {
        font-size: ${isNarrowTicket ? 11.5 : 12.1}px;
        font-weight: 800;
      }
` }      .comanda-cocina-print__items {
        display: grid;
        gap: 5px;
      }
${operationalSections ? `      .comanda-cocina-print__section + .comanda-cocina-print__section {
        margin-top: 7px;
      }
      .comanda-cocina-print__section-title {
        margin: 0 0 4px;
        padding-bottom: 2px;
        border-bottom: 1px solid #111;
        font-size: ${isNarrowTicket ? 11 : 12}px;
        font-weight: 900;
        letter-spacing: 0.04em;
      }
` : ''}      .comanda-cocina-print__item {
        border-bottom: 1px dashed #ccc;
        padding-bottom: 4px;
      }
      .comanda-cocina-print__item-head {
        display: flex;
        gap: 4px;
        align-items: baseline;
        min-width: 0;
        max-width: 100%;
      }
      .comanda-cocina-print__qty {
        flex: 0 0 ${qtyWidthMm}mm;
        min-width: 0;
        max-width: ${qtyWidthMm}mm;
        font-size: ${qtyFontPx}px;
        line-height: 1;
        font-weight: 800;
      }
      .comanda-cocina-print__name {
        flex: 1 1 auto;
        min-width: 0;
        max-width: 100%;
        font-size: ${nameFontPx}px;
        line-height: 1.1;
        font-weight: 800;
        text-transform: uppercase;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .comanda-cocina-print__tags,
      .comanda-cocina-print__notes {
        margin-top: 3px;
        padding-left: ${nestedPaddingMm}mm;
        display: grid;
        gap: 2px;
        min-width: 0;
        max-width: 100%;
      }
      .comanda-cocina-print__tag,
      .comanda-cocina-print__note {
        font-size: ${tagFontPx}px;
        line-height: 1.25;
        min-width: 0;
        max-width: 100%;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .comanda-cocina-print__tag-title,
      .comanda-cocina-print__note-title {
        font-weight: 700;
      }
      .comanda-cocina-print__general-note {
        margin-top: 6px;
        font-size: ${tagFontPx}px;
        line-height: 1.25;
        font-weight: 700;
        text-transform: uppercase;
        min-width: 0;
        max-width: 100%;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <section class="comanda-cocina-print-root">
      <article class="comanda-cocina-print">
        <header class="comanda-cocina-print__header">
          <h1>COMANDA COCINA</h1>
          <strong>${escapeHtml(numeroPedido)}</strong>
          <span>${escapeHtml(fecha)}</span>
        </header>

        <div class="comanda-cocina-print__divider"></div>

        <div class="comanda-cocina-print__meta">
          <div class="comanda-cocina-print__meta-row">
            <span>Sucursal</span>
            <span>${escapeHtml(sucursal)}</span>
          </div>
          <div class="comanda-cocina-print__meta-row">
            <span>Cajero</span>
            <span>${escapeHtml(cajero)}</span>
          </div>
          <div class="comanda-cocina-print__meta-row">
            <span>Modalidad</span>
            <span>${escapeHtml(modalidad)}</span>
          </div>
          <div class="comanda-cocina-print__meta-row">
            <span>Mesa</span>
            <span>${escapeHtml(mesa)}</span>
          </div>
${legacy ? `          <div class="comanda-cocina-print__meta-row">
            <span>Cliente</span>
            <span>${escapeHtml(cliente)}</span>
          </div>` : `          <div class="comanda-cocina-print__meta-row">
            <span>Cliente</span>
            <span class="comanda-cocina-print__customer-name">${escapeHtml(cliente)}</span>
          </div>`}
          ${telefonoCliente ? `
          <div class="comanda-cocina-print__meta-row">
            <span>Telefono</span>
            <span>${escapeHtml(telefonoCliente)}</span>
          </div>` : ''}
        </div>

        <div class="comanda-cocina-print__divider"></div>

        <div class="comanda-cocina-print__items">
          ${operationalSections ? `
          ${prepararItems.length > 0 ? `
          <section class="comanda-cocina-print__section">
            <h2 class="comanda-cocina-print__section-title">PREPARAR</h2>
            ${prepararItems.map((item) => `
            <section class="comanda-cocina-print__item">
              <div class="comanda-cocina-print__item-head">
                <span class="comanda-cocina-print__qty">${escapeHtml(item.cantidad)}x</span>
                <span class="comanda-cocina-print__name">${escapeHtml(item.nombreItem)}</span>
              </div>
              ${renderTags('Extra', item.extras, (extra) => `${escapeHtml(extra.nombre)} x${escapeHtml(extra.cantidad)}`)}
              ${renderTagSummary(item.complementos.length === 1 ? 'Salsa' : 'Salsas', item.complementos, (complemento) => complemento.nombre)}
              ${item.observacion ? `
                <div class="comanda-cocina-print__notes">
                  <div class="comanda-cocina-print__note">
                    <span class="comanda-cocina-print__note-title">Nota:</span>
                    <span>${escapeHtml(item.observacion)}</span>
                  </div>
                </div>
              ` : ''}
            </section>
            `).join('')}
          </section>
          ` : ''}
          ${entregaConjuntaItems.length > 0 ? `
          <section class="comanda-cocina-print__section">
            <h2 class="comanda-cocina-print__section-title">ENTREGAR JUNTO CON EL PEDIDO</h2>
            ${entregaConjuntaItems.map((item) => `
            <section class="comanda-cocina-print__item">
              <div class="comanda-cocina-print__item-head">
                <span class="comanda-cocina-print__qty">${escapeHtml(item.cantidad)}x</span>
                <span class="comanda-cocina-print__name">${escapeHtml(item.nombreItem)}</span>
              </div>
            </section>
            `).join('')}
          </section>
          ` : ''}
          ` : items.map((item) => `
            <section class="comanda-cocina-print__item">
              <div class="comanda-cocina-print__item-head">
                <span class="comanda-cocina-print__qty">${escapeHtml(item.cantidad)}x</span>
                <span class="comanda-cocina-print__name">${escapeHtml(item.nombreItem)}</span>
              </div>
              ${renderTags('Extra', item.extras, (extra) => `${escapeHtml(extra.nombre)} x${escapeHtml(extra.cantidad)}`)}
              ${renderTagSummary(item.complementos.length === 1 ? 'Salsa' : 'Salsas', item.complementos, (complemento) => complemento.nombre)}
              ${item.observacion ? `
                <div class="comanda-cocina-print__notes">
                  <div class="comanda-cocina-print__note">
                    <span class="comanda-cocina-print__note-title">Nota:</span>
                    <span>${escapeHtml(item.observacion)}</span>
                  </div>
                </div>
              ` : ''}
            </section>
          `).join('')}
        </div>

        ${notaGeneral ? `
          <div class="comanda-cocina-print__divider"></div>
          <div class="comanda-cocina-print__general-note">
            Nota cocina: ${escapeHtml(notaGeneral)}
          </div>
        ` : ''}
      </article>
    </section>
  </body>
</html>
  `.trim();
};

export default buildComandaCocinaHtml;
