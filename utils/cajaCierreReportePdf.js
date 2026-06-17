import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pdfmake from 'pdfmake';

const FONT_DIR = fileURLToPath(new URL('../node_modules/pdfmake/fonts/Roboto/', import.meta.url));
const FONT_DIR_PREFIX = path.resolve(FONT_DIR) + path.sep;

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

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatMoney = (value) =>
  `L ${toNumber(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

const formatDateTime = (value = new Date()) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return 'No disponible';
  return date.toLocaleString('es-HN', {
    timeZone: 'America/Tegucigalpa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const cleanText = (value, fallback = 'No disponible') => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
};

const cierreCode = (idCierreCaja) =>
  `CIE-${String(idCierreCaja || '').padStart(5, '0')}`;

const resolveActorLabel = (actors, primaryNameKey, primaryUserKey, fallback) =>
  cleanText(actors?.[primaryNameKey] || actors?.[primaryUserKey] || fallback);

const labelValueRows = (rows) =>
  rows.map(([label, value]) => [
    { text: label, style: 'labelCell' },
    { text: cleanText(value), style: 'valueCell' }
  ]);

const buildArqueosTableBody = (arqueos = []) => {
  const body = [[
    { text: 'Metodo', style: 'tableHeader' },
    { text: 'Teorico', style: 'tableHeader', alignment: 'right' },
    { text: 'Declarado', style: 'tableHeader', alignment: 'right' },
    { text: 'Diferencia', style: 'tableHeader', alignment: 'right' },
    { text: 'Revision', style: 'tableHeader' },
    { text: 'Observacion', style: 'tableHeader' }
  ]];

  if (!Array.isArray(arqueos) || arqueos.length === 0) {
    body.push([
      { text: 'Sin arqueos segmentados asociados.', colSpan: 6, color: '#667085' },
      {}, {}, {}, {}, {}
    ]);
    return body;
  }

  arqueos.forEach((row) => {
    body.push([
      cleanText(row.metodo_pago_codigo || row.id_metodo_pago || 'N/A', 'N/A'),
      { text: formatMoney(row.monto_teorico), alignment: 'right' },
      { text: formatMoney(row.monto_declarado), alignment: 'right' },
      { text: formatMoney(row.diferencia), alignment: 'right' },
      row.requiere_revision ? 'Si' : 'No',
      cleanText(row.observacion, 'N/A')
    ]);
  });

  return body;
};

export const buildCajaCierrePdfFilename = (idCierreCaja) =>
  `cierre-caja-${cierreCode(idCierreCaja)}.pdf`;

export const buildCajaCierrePdfBuffer = async (payload = {}) => {
  const responsableLabel = resolveActorLabel(
    payload.actors,
    'responsable_nombre',
    'responsable_usuario',
    payload.session?.id_usuario_responsable
  );
  const cierreLabel = resolveActorLabel(
    payload.actors,
    'cierre_nombre',
    'cierre_usuario',
    payload.idUsuarioCierre
  );
  const statusLabel = payload.requiresAudit ? 'REQUIERE AUDITORIA' : 'CIERRE REGISTRADO';
  const statusMessage = payload.requiresAudit
    ? 'Este cierre requiere auditoria preventiva por recuento, diferencia o inconsistencia detectada durante el proceso de cierre.'
    : 'Este cierre fue registrado sin inconsistencias pendientes de auditoria.';

  const docDefinition = {
    pageSize: 'LETTER',
    pageMargins: [36, 42, 36, 48],
    defaultStyle: {
      font: 'Roboto',
      fontSize: 9,
      color: '#1f2933'
    },
    footer: (currentPage, pageCount) => ({
      margin: [36, 0, 36, 18],
      columns: [
        { text: 'Documento generado automaticamente por JONNY\'S SmartOrder.', fontSize: 7, color: '#667085' },
        { text: `${currentPage} / ${pageCount}`, alignment: 'right', fontSize: 7, color: '#667085' }
      ]
    }),
    styles: {
      title: { fontSize: 18, bold: true, margin: [0, 0, 0, 2] },
      subtitle: { fontSize: 11, color: '#667085', margin: [0, 0, 0, 14] },
      section: { fontSize: 12, bold: true, margin: [0, 12, 0, 6] },
      status: { bold: true, color: payload.requiresAudit ? '#b42318' : '#027a48', margin: [0, 0, 0, 4] },
      labelCell: { bold: true, fillColor: '#f9fafb' },
      valueCell: {},
      tableHeader: { bold: true, fillColor: '#f2f4f7' }
    },
    content: [
      { text: 'JONNY\'S SmartOrder', style: 'title' },
      { text: 'Reporte de cierre de caja', style: 'subtitle' },
      {
        table: {
          widths: ['35%', '65%'],
          body: labelValueRows([
            ['Generado', formatDateTime(new Date())],
            ['Cierre', cierreCode(payload.idCierreCaja)],
            ['ID sesion', payload.idSesionCaja]
          ])
        },
        layout: 'lightHorizontalLines'
      },
      { text: 'Datos de caja', style: 'section' },
      {
        table: {
          widths: ['35%', '65%'],
          body: labelValueRows([
            ['Codigo de caja', payload.session?.codigo_caja || payload.session?.id_caja],
            ['Nombre de caja', payload.session?.nombre_caja],
            ['Sucursal', payload.session?.nombre_sucursal || payload.session?.id_sucursal],
            ['Responsable', responsableLabel],
            ['Usuario de cierre', cierreLabel],
            ['Fecha/hora de cierre', formatDateTime(payload.fechaCierre)]
          ])
        },
        layout: 'lightHorizontalLines'
      },
      { text: 'Estado del cierre', style: 'section' },
      { text: statusLabel, style: 'status' },
      { text: statusMessage },
      { text: 'Resumen monetario', style: 'section' },
      {
        table: {
          widths: ['40%', '60%'],
          body: labelValueRows([
            ['Monto apertura', formatMoney(payload.montoApertura)],
            ['Ventas efectivo', formatMoney(payload.ventasEfectivoNetas)],
            ['Ventas no efectivo', formatMoney(payload.ventasNoEfectivoNetas)],
            ['Ingresos manuales', formatMoney(payload.ingresosManuales)],
            ['Egresos manuales', formatMoney(payload.egresosManuales)],
            ['Total teorico', formatMoney(payload.montoTeorico)],
            ['Total declarado', formatMoney(payload.montoDeclaradoCierre)],
            ['Diferencia', formatMoney(payload.diferencia)]
          ])
        },
        layout: 'lightHorizontalLines'
      },
      { text: 'Resolucion y nomina', style: 'section' },
      {
        table: {
          widths: ['40%', '60%'],
          body: labelValueRows([
            ['Resolucion', payload.resolutionCode || payload.idResolucionFinal],
            ['Estado de nomina', payload.payrollSyncLabel],
            ['ID movimiento de planilla', payload.payrollSync?.id_movimiento_planilla || payload.payrollSync?.idMovimientoPlanilla || 'No disponible']
          ])
        },
        layout: 'lightHorizontalLines'
      },
      { text: 'Arqueos por metodo', style: 'section' },
      {
        table: {
          headerRows: 1,
          widths: ['15%', '15%', '15%', '15%', '12%', '28%'],
          body: buildArqueosTableBody(payload.arqueos)
        },
        layout: 'lightHorizontalLines'
      },
      {
        text: 'Este reporte forma parte del control interno de caja.',
        margin: [0, 14, 0, 0],
        color: '#667085',
        italics: true
      }
    ]
  };

  return pdfmake.createPdf(docDefinition).getBuffer();
};
