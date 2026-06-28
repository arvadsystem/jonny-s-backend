import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCajaCloseEmailSubject,
  claimCajaCloseEmailNotifications,
  createCajaCloseEmailNotification,
  markCajaCloseEmailNotificationFailed,
  processClaimedCajaCloseEmailNotification,
  resolveCajaCloseOutboxRecipient
} from '../cajaCloseEmailOutboxService.js';

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
