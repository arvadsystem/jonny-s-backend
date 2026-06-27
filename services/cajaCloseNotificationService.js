import pool from '../config/db-connection.js';
import { buildCajaCierrePdfBuffer, buildCajaCierrePdfFilename } from '../utils/cajaCierreReportePdf.js';

const defaultSendEmail = async (...args) => {
  const { enviarCorreo } = await import('../utils/emailService.js');
  return enviarCorreo(...args);
};

export const processCajaCloseNotification = async ({
  idCierreCaja,
  payload,
  dependencies = {}
}) => {
  const {
    pool: notificationPool = pool,
    fetchActors,
    fetchMovements,
    buildPdf = buildCajaCierrePdfBuffer,
    buildPdfFilename = buildCajaCierrePdfFilename,
    sendEmail = defaultSendEmail,
    buildHtml,
    to,
    subject
  } = dependencies;

  let client = null;
  let actors = {};
  let movimientosManuales = { ingresos: [], egresos: [] };

  try {
    client = await notificationPool.connect();
    if (typeof fetchActors === 'function') {
      actors = await fetchActors(client);
    }
    if (typeof fetchMovements === 'function') {
      movimientosManuales = await fetchMovements(client);
    }
  } finally {
    if (client) client.release();
  }

  const enrichedPayload = {
    ...payload,
    idCierreCaja,
    actors,
    movimientosManuales
  };

  const attachments = [];
  try {
    const pdfBuffer = await buildPdf(enrichedPayload);
    attachments.push({
      filename: buildPdfFilename(idCierreCaja),
      content: pdfBuffer,
      contentType: 'application/pdf'
    });
  } catch (pdfError) {
    console.warn('[caja_close_notification] No se pudo generar PDF:', pdfError?.message || pdfError);
  }

  await sendEmail(
    to,
    subject,
    typeof buildHtml === 'function' ? buildHtml({ ...enrichedPayload, pdfAttached: attachments.length > 0 }) : '',
    {
      id_usuario: payload?.session?.id_usuario_responsable,
      tipo_correo: 'caja_cierre',
      fromKey: 'ADMON',
      attachments
    }
  );

  return {
    sent: true,
    pdf_attached: attachments.length > 0
  };
};
