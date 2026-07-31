import PDFDocument from 'pdfkit';
import { formatHondurasDate, formatHondurasTime } from '../utils/hondurasDateTime.js';
import { normalizarDatosTicketDesdeSnapshot } from './facturacionSnapshotService.js';

const MM_TO_PT = 72 / 25.4;
const toWidth = (value) => Number(value) === 58 ? 58 : 80;
const toBoolean = (value, fallback = true) => value === null || value === undefined
  ? fallback
  : value === true;
const money = (value) => `L ${Number(value || 0).toFixed(2)}`;
const quantity = (value) => {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
};

const decodePdfLogo = (value) => {
  const match = String(value || '').match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    return Buffer.from(match[2], 'base64');
  } catch {
    return null;
  }
};

export const loadVentaReversionTicketData = async ({ db, idReversion }) => {
  const headerResult = await db.query(
    `
      SELECT
        fr.id_reversion,
        fr.codigo_reversion,
        fr.id_factura_original,
        fr.id_sucursal,
        fr.id_caja_original,
        fr.id_sesion_caja_original,
        fr.tipo_reversion,
        fr.motivo,
        fr.observacion,
        fr.monto_reversado,
        fr.estado,
        fr.creada_en,
        fr.creada_por,
        f.codigo_venta,
        f.fecha_hora_facturacion,
        f.facturacion_snapshot,
        s.nombre_sucursal,
        c.codigo_caja,
        c.nombre_caja,
        u.nombre_usuario,
        cfg.prefijo_reversion,
        cfg.ancho_ticket_mm,
        cfg.imprimir_comprobante_reversion,
        cfg.mostrar_venta_original_reversion,
        cfg.mostrar_codigo_reversion,
        cfg.mostrar_usuario_reversion,
        cfg.mostrar_caja_sesion_reversion,
        cfg.mostrar_motivo_reversion,
        cfg.mostrar_detalle_reversion,
        cfg.mostrar_total_reversion
      FROM public.facturas_reversiones fr
      INNER JOIN public.facturas f ON f.id_factura = fr.id_factura_original
      INNER JOIN public.sucursales s ON s.id_sucursal = fr.id_sucursal
      LEFT JOIN public.cajas c ON c.id_caja = fr.id_caja_original
      LEFT JOIN public.cajas_sesiones cs ON cs.id_sesion_caja = fr.id_sesion_caja_original
      LEFT JOIN public.usuarios u ON u.id_usuario = fr.creada_por
      LEFT JOIN public.facturacion_config_sucursal cfg ON cfg.id_sucursal = fr.id_sucursal
      WHERE fr.id_reversion = $1
      LIMIT 1
    `,
    [idReversion]
  );
  const header = headerResult.rows?.[0];
  if (!header) return null;

  const [linesResult, accumulatedResult] = await Promise.all([
    db.query(
      `
        SELECT
          rd.id_reversion_detalle,
          rd.id_detalle_factura,
          rd.tipo_item,
          COALESCE(
            dfo.origen_snapshot->>'nombre_item',
            df.origen_snapshot->>'nombre_item',
            p.nombre_producto,
            r.nombre_receta,
            'Item'
          ) AS nombre_item,
          rd.cantidad_revertida,
          rd.precio_unitario_original,
          rd.total_revertido,
          rd.devuelve_inventario,
          rd.motivo_no_devolucion,
          rd.preparacion_iniciada,
          rd.tipo_politica_inventario
        FROM public.facturas_reversiones_detalle rd
        LEFT JOIN public.detalle_facturas df
          ON df.id_detalle_factura = rd.id_detalle_factura
        LEFT JOIN public.detalle_facturas_origen dfo
          ON dfo.id_detalle_factura = rd.id_detalle_factura
        LEFT JOIN public.productos p
          ON p.id_producto = COALESCE(rd.id_producto, dfo.id_producto, df.id_producto)
        LEFT JOIN public.recetas r
          ON r.id_receta = COALESCE(rd.id_receta, dfo.id_receta, df.id_receta::int)
        WHERE rd.id_reversion = $1
        ORDER BY rd.id_reversion_detalle
      `,
      [idReversion]
    ),
    db.query(
      `
        SELECT NOT EXISTS (
          SELECT 1
          FROM public.detalle_facturas df
          WHERE df.id_factura = $1
            AND COALESCE(df.cantidad, 1) > COALESCE((
              SELECT SUM(rda.cantidad_revertida)
              FROM public.facturas_reversiones_detalle rda
              INNER JOIN public.facturas_reversiones fra
                ON fra.id_reversion = rda.id_reversion
               AND UPPER(TRIM(COALESCE(fra.estado, ''))) = 'APLICADA'
              WHERE rda.id_detalle_factura = df.id_detalle_factura
            ), 0)
        ) AS factura_totalmente_reversada
      `,
      [header.id_factura_original]
    )
  ]);

  const facturacion = await normalizarDatosTicketDesdeSnapshot({
    client: db,
    factura: {
      id_sucursal: header.id_sucursal,
      facturacion_snapshot: header.facturacion_snapshot
    },
    includePrintAssets: true
  });

  return {
    ...header,
    facturacion,
    ancho_ticket_mm: toWidth(header.ancho_ticket_mm),
    imprimir_comprobante_reversion: toBoolean(header.imprimir_comprobante_reversion),
    mostrar_venta_original_reversion: toBoolean(header.mostrar_venta_original_reversion),
    mostrar_codigo_reversion: toBoolean(header.mostrar_codigo_reversion),
    mostrar_usuario_reversion: toBoolean(header.mostrar_usuario_reversion),
    mostrar_caja_sesion_reversion: toBoolean(header.mostrar_caja_sesion_reversion),
    mostrar_motivo_reversion: toBoolean(header.mostrar_motivo_reversion),
    mostrar_detalle_reversion: toBoolean(header.mostrar_detalle_reversion),
    mostrar_total_reversion: toBoolean(header.mostrar_total_reversion),
    resultado_acumulado: accumulatedResult.rows?.[0]?.factura_totalmente_reversada === true ? 'TOTAL' : 'PARCIAL',
    lineas: linesResult.rows || []
  };
};

export const buildVentaReversionTicketModel = (data) => {
  const timestamp = data?.creada_en || new Date();
  const code = String(data?.codigo_reversion || `${data?.prefijo_reversion || 'REV'}-${data?.id_reversion || ''}`).trim();
  const fields = [
    { label: 'Fecha', value: `${formatHondurasDate(timestamp)} ${formatHondurasTime(timestamp)}` },
    { label: 'Sucursal', value: data?.nombre_sucursal || `Sucursal ${data?.id_sucursal || ''}` }
  ];
  if (data?.mostrar_codigo_reversion) fields.push({ label: 'Codigo REV', value: code });
  if (data?.mostrar_venta_original_reversion) {
    fields.push({ label: 'Venta original', value: data?.codigo_venta || `VTA-${data?.id_factura_original || ''}` });
  }
  if (data?.mostrar_caja_sesion_reversion) {
    fields.push({
      label: 'Caja / sesion',
      value: `${data?.nombre_caja || data?.codigo_caja || data?.id_caja_original || '-'} / ${data?.id_sesion_caja_original || '-'}`
    });
  }
  if (data?.mostrar_usuario_reversion) fields.push({ label: 'Usuario', value: data?.nombre_usuario || `Usuario ${data?.creada_por || ''}` });
  if (data?.mostrar_motivo_reversion) fields.push({ label: 'Motivo', value: data?.motivo || '-' });
  fields.push({ label: 'Tipo solicitado', value: data?.tipo_reversion || '-' });
  fields.push({ label: 'Resultado acumulado', value: data?.resultado_acumulado || 'PARCIAL' });
  const facturacion = data?.facturacion && typeof data.facturacion === 'object' ? data.facturacion : {};
  const emisor = facturacion.emisor && typeof facturacion.emisor === 'object' ? facturacion.emisor : {};
  const ticket = facturacion.ticket && typeof facturacion.ticket === 'object' ? facturacion.ticket : {};

  return {
    widthMm: toWidth(data?.ancho_ticket_mm),
    branding: {
      logo: ticket.mostrar_logo_ticket === true ? decodePdfLogo(emisor.logo_data_url) : null,
      nombre: emisor.nombre_emisor || "JONNY'S",
      textoEncabezado: ticket.texto_encabezado_ticket || null,
      rtn: ticket.mostrar_rtn !== false ? emisor.rtn_emisor || null : null,
      direccion: ticket.mostrar_direccion !== false ? emisor.direccion_emisor || null : null,
      telefono: ticket.mostrar_telefono !== false ? emisor.telefono_emisor || null : null,
      correo: ticket.mostrar_correo === true ? emisor.correo_emisor || null : null
    },
    title: 'COMPROBANTE DE REVERSIÓN',
    disclaimer: 'NO ES FACTURA',
    fields,
    observation: data?.mostrar_motivo_reversion ? String(data?.observacion || '').trim() || null : null,
    lines: data?.mostrar_detalle_reversion
      ? (Array.isArray(data?.lineas) ? data.lineas : []).map((line) => ({
          name: line.nombre_item || 'Item',
          quantity: quantity(line.cantidad_revertida),
          unitPrice: money(line.precio_unitario_original),
          total: money(line.total_revertido),
          inventoryPolicy: line.tipo_politica_inventario || null,
          inventoryReason: line.motivo_no_devolucion || null,
          preparationStarted: line.preparacion_iniciada === true
        }))
      : [],
    showDetail: data?.mostrar_detalle_reversion === true,
    total: data?.mostrar_total_reversion ? money(data?.monto_reversado) : null
  };
};

export const buildVentaReversionTicketPdfBuffer = async (data) => {
  const model = buildVentaReversionTicketModel(data);
  const widthPt = model.widthMm * MM_TO_PT;
  const brandingLines = [
    model.branding.nombre,
    model.branding.textoEncabezado,
    model.branding.rtn,
    model.branding.direccion,
    model.branding.telefono,
    model.branding.correo
  ].filter(Boolean).length;
  const estimatedHeight = Math.max(
    420,
    270 + brandingLines * 14 + (model.branding.logo ? 72 : 0) + model.fields.length * 18 + model.lines.length * 34
  );
  const doc = new PDFDocument({
    size: [widthPt, estimatedHeight],
    margins: { top: 12, right: 12, bottom: 12, left: 12 },
    compress: false,
    info: { Title: model.title, Subject: model.disclaimer }
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  if (model.branding.logo) {
    doc.image(model.branding.logo, {
      fit: [widthPt - 24, model.widthMm === 58 ? 54 : 72],
      align: 'center'
    });
    doc.moveDown(0.3);
  }
  doc.font('Helvetica-Bold').fontSize(model.widthMm === 58 ? 9 : 10).text(model.branding.nombre, { align: 'center' });
  if (model.branding.textoEncabezado) doc.font('Helvetica').fontSize(8).text(model.branding.textoEncabezado, { align: 'center' });
  if (model.branding.rtn) doc.font('Helvetica').fontSize(8).text(`RTN: ${model.branding.rtn}`, { align: 'center' });
  if (model.branding.direccion) doc.font('Helvetica').fontSize(8).text(model.branding.direccion, { align: 'center' });
  if (model.branding.telefono) doc.font('Helvetica').fontSize(8).text(`Tel: ${model.branding.telefono}`, { align: 'center' });
  if (model.branding.correo) doc.font('Helvetica').fontSize(8).text(model.branding.correo, { align: 'center' });
  doc.moveDown(0.35).dash(2, { space: 2 }).moveTo(12, doc.y).lineTo(widthPt - 12, doc.y).stroke().undash();
  doc.moveDown(0.4).font('Helvetica-Bold').fontSize(model.widthMm === 58 ? 11 : 13).text(model.title, { align: 'center' });
  doc.fontSize(10).text(model.disclaimer, { align: 'center' });
  doc.moveDown(0.5).dash(2, { space: 2 }).moveTo(12, doc.y).lineTo(widthPt - 12, doc.y).stroke().undash();
  doc.moveDown(0.4);
  for (const field of model.fields) {
    doc.font('Helvetica-Bold').fontSize(8).text(`${field.label}: `, { continued: true });
    doc.font('Helvetica').text(String(field.value || '-'));
  }
  if (model.observation) doc.font('Helvetica').fontSize(8).text(`Observacion: ${model.observation}`);
  if (model.showDetail) {
    doc.moveDown(0.4).font('Helvetica-Bold').fontSize(9).text('Detalle de esta reversion');
    for (const line of model.lines) {
      doc.font('Helvetica-Bold').fontSize(8).text(line.name);
      doc.font('Helvetica').text(`${line.quantity} x ${line.unitPrice}`, { continued: true });
      doc.text(line.total, { align: 'right' });
      if (line.inventoryReason === 'PREPARACION_INICIADA') {
        doc.font('Helvetica').fontSize(7).text('Inventario: no devuelto; preparación iniciada.');
      }
    }
  }
  if (model.total) {
    doc.moveDown(0.4).dash(2, { space: 2 }).moveTo(12, doc.y).lineTo(widthPt - 12, doc.y).stroke().undash();
    doc.moveDown(0.3).font('Helvetica-Bold').fontSize(10).text(`TOTAL REVERSADO: ${model.total}`, { align: 'right' });
  }
  doc.end();
  return complete;
};
