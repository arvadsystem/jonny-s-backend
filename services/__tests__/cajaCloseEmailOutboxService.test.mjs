import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCajaCloseEmailHtml,
  buildCajaCloseEmailSubject,
  claimCajaCloseEmailNotifications,
  createCajaCloseEmailNotification,
  loadCajaCloseEmailPayload,
  markCajaCloseEmailNotificationFailed,
  normalizeManualMovement,
  processClaimedCajaCloseEmailNotification,
  resolveCajaCloseOutboxRecipient
} from '../cajaCloseEmailOutboxService.js';
import {
  buildCajaCierrePdfDefinition,
  formatCajaCierreDateTime
} from '../../utils/cajaCierreReportePdf.js';

const routerSource = readFileSync(resolve('routers/cajas.js'), 'utf8');
const serverSource = readFileSync(resolve('server.js'), 'utf8');
const migrationSource = readFileSync(resolve('sql/2026-06-28_caja_close_email_outbox.sql'), 'utf8');
const emailServiceSource = readFileSync(resolve('utils/emailService.js'), 'utf8');

const withCajaCloseEmailTo = async (value, fn) => {
  const previous = process.env.CAJA_CLOSE_EMAIL_TO;
  if (value === undefined) {
    delete process.env.CAJA_CLOSE_EMAIL_TO;
  } else {
    process.env.CAJA_CLOSE_EMAIL_TO = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CAJA_CLOSE_EMAIL_TO;
    } else {
      process.env.CAJA_CLOSE_EMAIL_TO = previous;
    }
  }
};

const buildSampleClosePayload = () => ({
  generatedAt: '2026-06-28 12:00:00',
  idCierreCaja: '2',
  idSesionCaja: '1',
  session: {
    id_caja: 10,
    id_sucursal: 1,
    codigo_caja: 'CJ-1',
    nombre_caja: 'Caja 1',
    nombre_sucursal: 'Sucursal 1'
  },
  actors: {
    responsable_nombre: 'Cajero Prueba',
    responsable_usuario: 'cajero.prueba',
    cierre_nombre: 'Cajero Prueba',
    cierre_usuario: 'cajero.prueba'
  },
  fechaCierre: '2026-06-28 10:00:00',
  montoApertura: 100,
  ventasEfectivoNetas: 900,
  ventasNoEfectivoNetas: 300,
  ingresosManuales: 1200,
  egresosManuales: 1200,
  montoTeorico: 1300,
  montoDeclaradoCierre: 1300,
  diferencia: 0,
  idResolucionFinal: 3,
  resolutionCode: 'CAJA_CUADRA',
  requiresAudit: false,
  payrollSyncLabel: 'No requerido',
  payrollSync: {
    synced: true,
    reason: 'NOT_REQUIRED'
  },
  arqueos: [{
    metodo_pago_codigo: 'EFECTIVO',
    monto_teorico: 1000,
    monto_declarado: 1000,
    diferencia: 0,
    requiere_revision: false,
    observacion: 'Cuadrado'
  }],
  movimientosManuales: {
    ingresos: [{
      fecha_hora: '2026-06-28 09:00:00',
      monto: 500,
      observacion: 'Ingreso manual caja',
      referencia: 'REF-IN-1',
      usuario_ejecutor: 'Cajero Prueba'
    }],
    egresos: [{
      fecha_hora: '2026-06-28 09:05:00',
      monto: 300,
      observacion: 'Egreso manual caja',
      referencia: 'N/A',
      usuario_ejecutor: 'Cajero Prueba'
    }]
  }
});

const stripHtml = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('caja close email durable outbox', () => {
  it('crea cierre y outbox en la misma transaccion sin depender de cola en memoria', () => {
    const closeHandlerStart = routerSource.indexOf('const closeSessionHandler = async');
    const closeHandlerEnd = routerSource.indexOf("router.patch('/ventas/cajas/sesiones/:id/cerrar'", closeHandlerStart);
    const closeHandlerSource = routerSource.slice(closeHandlerStart, closeHandlerEnd);
    assert.match(closeHandlerSource, /withDbTransaction\(async \(client\) =>/);
    assert.match(closeHandlerSource, /INSERT INTO public\.cajas_cierres/);
    assert.match(closeHandlerSource, /createCajaCloseEmailNotification\(client,\s*\{/);
    assert.match(closeHandlerSource, /correo_cierre:\s*\{/);
    assert.doesNotMatch(closeHandlerSource, /enqueueCajaCloseEmailNotification/);
    assert.doesNotMatch(closeHandlerSource, /cajas_usuarios_autorizados/);
  });

  it('migracion define outbox persistente e idempotente con fechas tecnicas timestamptz', () => {
    assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS public\.cajas_cierres_notificaciones_email/);
    assert.match(migrationSource, /id_notificacion BIGSERIAL PRIMARY KEY/);
    assert.match(migrationSource, /id_cierre_caja BIGINT NOT NULL REFERENCES public\.cajas_cierres\(id_cierre_caja\)/);
    assert.match(migrationSource, /estado TEXT NOT NULL DEFAULT 'PENDIENTE'/);
    assert.match(migrationSource, /CONSTRAINT uq_cajas_cierres_notificaciones_email_cierre UNIQUE \(id_cierre_caja\)/);
    assert.match(migrationSource, /estado IN \('PENDIENTE', 'PROCESANDO', 'ENVIADO', 'REINTENTO', 'FALLIDO'\)/);
    for (const column of ['proximo_intento', 'bloqueado_hasta', 'fecha_creacion', 'fecha_actualizacion', 'fecha_envio']) {
      assert.match(migrationSource, new RegExp(`${column} TIMESTAMPTZ`, 'i'));
    }
  });

  it('reinicio del proceso recupera notificaciones persistidas al arrancar el backend', () => {
    assert.match(serverSource, /startCajaCloseEmailOutboxWorker\(\)/);
    assert.match(serverSource, /stopCajaCloseEmailOutboxWorker\(\{ timeoutMs: 5000 \}\)/);
  });

  it('resuelve destinatario QA y fallback de produccion', async () => {
    await withCajaCloseEmailTo('arvadsystem@gmail.com', async () => {
      assert.equal(resolveCajaCloseOutboxRecipient('fallback@example.com'), 'arvadsystem@gmail.com');
    });
    await withCajaCloseEmailTo(undefined, async () => {
      assert.equal(resolveCajaCloseOutboxRecipient('fallback@example.com'), 'fallback@example.com');
    });
  });

  it('inserta outbox con ON CONFLICT para no duplicar notificacion al repetir cierre', async () => {
    const calls = [];
    const fakeClient = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ id_notificacion: 9, id_cierre_caja: params[0], estado: 'PENDIENTE' }] };
      }
    };
    await withCajaCloseEmailTo('arvadsystem@gmail.com', async () => {
      const row = await createCajaCloseEmailNotification(fakeClient, { idCierreCaja: 123, emailDestino: 'fallback@example.com' });
      assert.equal(row.estado, 'PENDIENTE');
    });
    assert.match(calls[0].sql, /ON CONFLICT \(id_cierre_caja\)/);
    assert.deepEqual(calls[0].params, ['123', 'arvadsystem@gmail.com']);
  });

  it('reclama con FOR UPDATE SKIP LOCKED y libera PROCESANDO abandonados', async () => {
    const calls = [];
    const fakeClient = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      }
    };
    await claimCajaCloseEmailNotifications({ queryRunner: fakeClient, batchSize: 2, lockMs: 30000 });
    assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(calls[0].sql, /estado = 'PROCESANDO'[\s\S]*bloqueado_hasta IS NOT NULL[\s\S]*bloqueado_hasta <= NOW\(\)/);
    assert.match(calls[0].sql, /SET estado = 'PROCESANDO'/);
    assert.deepEqual(calls[0].params, [2, '30000 milliseconds']);
  });

  it('error SMTP genera reintento y despues de 5 errores queda FALLIDO', async () => {
    const updates = [];
    const fakeClient = {
      async query(sql, params) {
        updates.push({ sql, params });
        return { rows: [{ id_notificacion: params[0], estado: params[1], intentos: params[2] }] };
      }
    };
    const retry = await markCajaCloseEmailNotificationFailed(fakeClient, { id_notificacion: 1, intentos: 0 }, new Error('smtp down'));
    const failed = await markCajaCloseEmailNotificationFailed(fakeClient, { id_notificacion: 1, intentos: 4 }, new Error('smtp down'));
    assert.equal(retry.estado, 'REINTENTO');
    assert.equal(failed.estado, 'FALLIDO');
    assert.match(updates[0].sql, /proximo_intento = CASE/);
    assert.equal(updates[0].params[4], 'smtp down');
  });

  it('payload de correo resuelve actores, movimientos manuales y arqueos reales', async () => {
    const queries = [];
    const fakeQueryRunner = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/FROM public\.cajas_cierres cc/.test(sql)) {
          return {
            rows: [{
              id_cierre_caja: 2,
              id_sesion_caja: 1,
              id_caja: 10,
              id_sucursal: 1,
              id_usuario_responsable: 37,
              sesion_id_usuario_responsable: 37,
              id_usuario_cierre: 37,
              fecha_cierre: '2026-06-28 10:00:00',
              codigo_caja: 'CJ-1',
              nombre_caja: 'Caja 1',
              nombre_sucursal: 'Sucursal 1',
              monto_teorico_cierre: '1200',
              monto_declarado_cierre: '1200',
              diferencia: '0',
              monto_apertura: '0',
              monto_ventas_efectivo: '0',
              monto_ventas_no_efectivo: '0',
              monto_ingresos_manuales: '1200',
              monto_egresos_manuales: '1200',
              resolucion_codigo: 'CAJA_CUADRA'
            }]
          };
        }
        if (/FROM public\.usuarios u/.test(sql)) {
          return {
            rows: [{
              id_usuario: 37,
              nombre_usuario: 'cajero.prueba',
              nombre_completo: 'Cajero Prueba'
            }]
          };
        }
        if (/FROM public\.cajas_movimientos cm/.test(sql)) {
          return {
            rows: [
              {
                id_movimiento_caja: 1,
                fecha_movimiento: '2026-06-28 09:00:00',
                monto: '500',
                observacion: 'Ingreso manual caja',
                referencia: 'REF-IN-1',
                tipo_codigo: 'INGRESO_MANUAL',
                tipo_nombre: 'Ingreso manual',
                signo: 1,
                usuario_ejecutor_nombre: 'Cajero Prueba',
                usuario_ejecutor_usuario: 'cajero.prueba'
              },
              {
                id_movimiento_caja: 2,
                fecha_movimiento: '2026-06-28 09:05:00',
                monto: '300',
                observacion: 'Egreso manual caja',
                referencia: null,
                tipo_codigo: 'EGRESO_MANUAL',
                tipo_nombre: 'Egreso manual',
                signo: -1,
                usuario_ejecutor_nombre: 'Cajero Prueba',
                usuario_ejecutor_usuario: 'cajero.prueba'
              }
            ]
          };
        }
        if (/FROM public\.cajas_cierres_arqueos_metodos/.test(sql)) {
          return {
            rows: [{
              metodo_pago_codigo: 'EFECTIVO',
              monto_teorico: '1200',
              monto_declarado: '1200',
              diferencia: '0',
              requiere_revision: false,
              observacion: 'Cuadrado'
            }]
          };
        }
        return { rows: [] };
      }
    };

    const payload = await loadCajaCloseEmailPayload(fakeQueryRunner, 2);
    assert.equal(payload.actors.responsable_nombre, 'Cajero Prueba');
    assert.equal(payload.actors.cierre_nombre, 'Cajero Prueba');
    assert.equal(payload.movimientosManuales.ingresos.length, 1);
    assert.equal(payload.movimientosManuales.egresos.length, 1);
    assert.equal(payload.movimientosManuales.ingresos[0].observacion, 'Ingreso manual caja');
    assert.equal(payload.movimientosManuales.ingresos[0].referencia, 'REF-IN-1');
    assert.equal(payload.movimientosManuales.egresos[0].referencia, 'N/A');
    assert.equal(payload.arqueos[0].metodo_pago_codigo, 'EFECTIVO');
    assert.match(queries.find((call) => /FROM public\.cajas_movimientos cm/.test(call.sql)).sql, /NOT IN \('APERTURA', 'REVERSION', 'REVERSO'\)/);
  });

  it('normaliza movimientos manuales sin perder observacion, referencia ni ejecutor', () => {
    assert.deepEqual(
      normalizeManualMovement({
        fecha_movimiento: '2026-06-28 08:00:00',
        tipo_codigo: 'INGRESO',
        tipo_nombre: 'Ingreso',
        monto: '100',
        observacion: '  Fondo extra  ',
        referencia: '  REF-1 ',
        usuario_ejecutor_nombre: 'Cajero Prueba',
        signo: 1
      }),
      {
        fecha_hora: '2026-06-28 08:00:00',
        tipo_codigo: 'INGRESO',
        tipo: 'Ingreso',
        monto: 100,
        observacion: 'Fondo extra',
        referencia: 'REF-1',
        usuario_ejecutor: 'Cajero Prueba',
        signo: 1
      }
    );
    assert.equal(normalizeManualMovement({ referencia: '   ' }).referencia, 'N/A');
  });

  it('HTML y PDF contienen la misma informacion funcional con valores concretos', () => {
    const payload = buildSampleClosePayload();
    const htmlText = stripHtml(buildCajaCloseEmailHtml({ payload, pdfAttached: false }));
    const pdfDefinitionText = JSON.stringify(buildCajaCierrePdfDefinition(payload));
    const expectedGeneratedAt = formatCajaCierreDateTime('2026-06-28 12:00:00');
    const expectedCloseAt = formatCajaCierreDateTime('2026-06-28 10:00:00');
    const commonValues = [
      'Cajero Prueba',
      'Caja 1',
      'Sucursal 1',
      expectedGeneratedAt,
      expectedCloseAt,
      '1',
      'CJ-1',
      'L 100.00',
      'L 900.00',
      'L 300.00',
      'L 1,200.00',
      'L 1,300.00',
      'CAJA_CUADRA',
      'No requerido',
      'No disponible',
      'CIERRE REGISTRADO',
      'EFECTIVO',
      'Cuadrado',
      'Ingreso manual caja',
      'Egreso manual caja',
      'REF-IN-1',
      'N/A'
    ];
    const htmlLabels = [
      'Fecha de generacion',
      'ID sesion',
      'Codigo de caja',
      'Fecha/hora de cierre',
      'Monto de apertura',
      'Ventas en efectivo',
      'Ventas no efectivas',
      'Total de ingresos manuales',
      'Total de egresos manuales',
      'Resolucion',
      'Estado de nomina',
      'ID movimiento de planilla',
      'Responsable',
      'Usuario de cierre',
      'Total teorico',
      'Total declarado',
      'Diferencia',
      'Estado de revision',
      'Arqueos por metodo',
      'Ingresos manuales',
      'Egresos manuales'
    ];
    const pdfLabels = [
      'Generado',
      'ID sesion',
      'Fecha/hora de cierre',
      'Monto apertura',
      'Ventas efectivo',
      'Ventas no efectivo',
      'Ingresos manuales',
      'Egresos manuales',
      'Resolucion',
      'Estado de nomina',
      'ID movimiento de planilla',
      'Responsable',
      'Usuario de cierre',
      'Total teorico',
      'Total declarado',
      'Diferencia',
      'Arqueos por metodo'
    ];

    for (const label of htmlLabels) assert.match(htmlText, new RegExp(label));
    for (const label of pdfLabels) assert.match(pdfDefinitionText, new RegExp(label));
    for (const value of commonValues) {
      assert.match(htmlText, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(pdfDefinitionText, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    assert.doesNotMatch(htmlText, /Responsable\s+37\b/);
    assert.doesNotMatch(htmlText, /Usuario de cierre\s+37\b/);
    assert.doesNotMatch(pdfDefinitionText, /"37"/);
    assert.doesNotMatch(pdfDefinitionText, /"Tipo"/);
  });

  it('interpreta timestamps sin zona como UTC para HTML y PDF', () => {
    const expected = '28/06/2026, 04:00 a. m.';
    assert.equal(formatCajaCierreDateTime('2026-06-28 10:00:00'), expected);

    const payload = buildSampleClosePayload();
    const htmlText = stripHtml(buildCajaCloseEmailHtml({ payload, pdfAttached: false }));
    const pdfDefinitionText = JSON.stringify(buildCajaCierrePdfDefinition(payload));
    assert.match(htmlText, /28\/06\/2026, 04:00 a\. m\./);
    assert.match(pdfDefinitionText, /28\/06\/2026, 04:00 a\. m\./);
  });

  it('si falla buildPdf envia HTML completo y marca outbox ENVIADO', async () => {
    const queries = [];
    const fakeQueryRunner = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/FROM public\.cajas_cierres cc/.test(sql)) {
          return {
            rows: [{
              id_cierre_caja: 2,
              id_sesion_caja: 1,
              id_caja: 10,
              id_sucursal: 1,
              id_usuario_responsable: 37,
              sesion_id_usuario_responsable: 37,
              id_usuario_cierre: 37,
              fecha_cierre: '2026-06-28 10:00:00',
              codigo_caja: 'CJ-1',
              nombre_caja: 'Caja 1',
              nombre_sucursal: 'Sucursal 1',
              monto_teorico_cierre: '1300',
              monto_declarado_cierre: '1300',
              diferencia: '0',
              monto_apertura: '100',
              monto_ventas_efectivo: '900',
              monto_ventas_no_efectivo: '300',
              monto_ingresos_manuales: '1200',
              monto_egresos_manuales: '1200',
              resolucion_codigo: 'CAJA_CUADRA'
            }]
          };
        }
        if (/FROM public\.usuarios u/.test(sql)) {
          return {
            rows: [{
              id_usuario: 37,
              nombre_usuario: 'cajero.prueba',
              nombre_completo: 'Cajero Prueba'
            }]
          };
        }
        if (/FROM public\.cajas_movimientos cm/.test(sql)) {
          return {
            rows: [
              {
                fecha_movimiento: '2026-06-28 09:00:00',
                monto: '500',
                observacion: 'Ingreso manual caja',
                referencia: 'REF-IN-1',
                tipo_codigo: 'INGRESO_MANUAL',
                tipo_nombre: 'Ingreso manual',
                signo: 1,
                usuario_ejecutor_nombre: 'Cajero Prueba',
                usuario_ejecutor_usuario: 'cajero.prueba'
              },
              {
                fecha_movimiento: '2026-06-28 09:05:00',
                monto: '300',
                observacion: 'Egreso manual caja',
                referencia: null,
                tipo_codigo: 'EGRESO_MANUAL',
                tipo_nombre: 'Egreso manual',
                signo: -1,
                usuario_ejecutor_nombre: 'Cajero Prueba',
                usuario_ejecutor_usuario: 'cajero.prueba'
              }
            ]
          };
        }
        if (/FROM public\.cajas_cierres_arqueos_metodos/.test(sql)) {
          return {
            rows: [{
              metodo_pago_codigo: 'EFECTIVO',
              monto_teorico: '1000',
              monto_declarado: '1000',
              diferencia: '0',
              requiere_revision: false,
              observacion: 'Cuadrado'
            }]
          };
        }
        if (/UPDATE public\.cajas_cierres_notificaciones_email/.test(sql)) {
          return { rows: [{ estado: 'ENVIADO', message_id: params[1] }] };
        }
        return { rows: [] };
      }
    };
    const sent = [];
    const result = await processClaimedCajaCloseEmailNotification(
      { id_notificacion: 1, id_cierre_caja: 2, email_destino: 'fallback@example.com', intentos: 0 },
      {
        queryRunner: fakeQueryRunner,
        async sendEmail(to, subject, html, meta) {
          sent.push({ to, subject, html: stripHtml(html), meta });
          return { messageId: 'smtp-message-id' };
        },
        async buildPdf() {
          throw new Error('pdf unavailable');
        },
        buildPdfFilename() {
          return 'cierre.pdf';
        }
      }
    );

    assert.equal(result.estado, 'ENVIADO');
    assert.equal(sent[0].meta.attachments.length, 0);
    for (const value of [
      'Cajero Prueba',
      'Monto de apertura',
      'L 100.00',
      'Ventas en efectivo',
      'L 900.00',
      'Arqueos por metodo',
      'EFECTIVO',
      'Ingresos manuales',
      'Ingreso manual caja',
      'Egresos manuales',
      'Egreso manual caja',
      'N/A'
    ]) {
      assert.match(sent[0].html, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.doesNotMatch(sent[0].html, /Responsable\s+37\b/);
    assert.doesNotMatch(sent[0].html, /Usuario de cierre\s+37\b/);
  });

  it('envio exitoso guarda message_id y usa log_correos_enviados por enviarCorreo', async () => {
    const queries = [];
    const fakeQueryRunner = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/FROM public\.cajas_cierres cc/.test(sql)) {
          return {
            rows: [{
              id_cierre_caja: 77,
              id_sesion_caja: 88,
              id_caja: 6,
              id_sucursal: 1,
              id_usuario_responsable: 12,
              id_usuario_cierre: 12,
              codigo_caja: 'CJ-1',
              nombre_caja: 'Caja 1',
              nombre_sucursal: 'Sucursal 1',
              monto_teorico_cierre: 100,
              monto_declarado_cierre: 100,
              diferencia: 0,
              resolucion_codigo: 'CAJA_CUADRA'
            }]
          };
        }
        if (/UPDATE public\.cajas_cierres_notificaciones_email/.test(sql)) {
          return { rows: [{ estado: 'ENVIADO', message_id: params[1] }] };
        }
        return { rows: [] };
      }
    };
    const sent = [];
    const result = await processClaimedCajaCloseEmailNotification(
      { id_notificacion: 1, id_cierre_caja: 77, email_destino: 'fallback@example.com', intentos: 0 },
      {
        queryRunner: fakeQueryRunner,
        async sendEmail(to, subject, html, meta) {
          sent.push({ to, subject, html, meta });
          return { messageId: 'smtp-message-id' };
        },
        async buildPdf() {
          return Buffer.from('pdf');
        },
        buildPdfFilename() {
          return 'cierre.pdf';
        }
      }
    );
    assert.equal(result.estado, 'ENVIADO');
    assert.equal(result.message_id, 'smtp-message-id');
    assert.equal(sent[0].meta.tipo_correo, 'caja_cierre');
    assert.match(emailServiceSource, /INSERT INTO log_correos_enviados/);
    assert.match(emailServiceSource, /UPDATE log_correos_enviados SET estado_envio = 'enviado'/);
  });

  it('reintento manual es solo SUPER_ADMIN y no duplica registros', () => {
    const routeStart = routerSource.indexOf("router.post('/ventas/cajas/cierres/:id/reintentar-correo'");
    const routeEnd = routerSource.indexOf("router.post('/ventas/cajas/sesiones/:id/cierre-validaciones'", routeStart);
    const routeSource = routerSource.slice(routeStart, routeEnd);
    assert.match(routeSource, /requestIsSuperAdminReal\(client,\s*req\)/);
    assert.match(routeSource, /fetchCajaCloseEmailNotificationByCloseId\(client,\s*idCierreCaja\)/);
    assert.match(routeSource, /currentNotification\.estado !== 'FALLIDO'/);
    assert.match(routeSource, /reactivateFailedCajaCloseEmailNotification\(client,\s*idCierreCaja\)/);
    assert.doesNotMatch(routeSource, /INSERT INTO public\.cajas_cierres_notificaciones_email[\s\S]*INSERT INTO public\.cajas_cierres_notificaciones_email/);
  });

  it('agrega estado de correo al detalle y no cambia aperturas', () => {
    assert.match(routerSource, /correo_estado:\s*cierreNotificacion\?\.estado/);
    assert.match(routerSource, /notificacion_correo:\s*cierreNotificacion/);
    const aperturaStart = routerSource.indexOf('const sendCajaAperturaEmail');
    const aperturaEnd = routerSource.indexOf('const fetchSessionBase', aperturaStart);
    const aperturaSource = routerSource.slice(aperturaStart, aperturaEnd);
    assert.match(aperturaSource, /enviarCorreo\(\s*CAJA_APERTURA_EMAIL_TO/);
    assert.doesNotMatch(aperturaSource, /CAJA_CLOSE_EMAIL_TO|cajas_cierres_notificaciones_email/);
  });

  it('construye asunto deterministico para worker', () => {
    assert.equal(
      buildCajaCloseEmailSubject({
        payload: {
          requiresAudit: false,
          session: { nombre_caja: 'Caja Central', nombre_sucursal: 'Sucursal 1' }
        }
      }),
      'Cierre de caja registrado - Caja Central - Sucursal 1'
    );
  });
});
