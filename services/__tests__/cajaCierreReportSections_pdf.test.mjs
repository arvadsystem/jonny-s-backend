import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { loadCajaCloseReportSections } from '../cajaCloseReportSectionsService.js';
import {
  buildCajaCloseEmailHtml,
  createCajaCloseEmailNotification,
  sendCajaCloseEmailFromOutbox
} from '../cajaCloseEmailOutboxService.js';
import {
  buildCajaCierrePdfBuffer,
  buildCajaCierrePdfDefinition
} from '../../utils/cajaCierreReportePdf.js';

const reversalRows = [
  {
    id_reversion: 11,
    codigo_reversion: 'REV-11',
    id_factura_original: 81,
    codigo_venta: 'VTA-81',
    tipo_reversion: 'PARCIAL',
    resultado_acumulado: 'PARCIAL',
    motivo: 'ERROR <digitacion>',
    observacion: 'Cliente & caja',
    monto_reversado: '25.50',
    creada_en: '2026-07-29 14:00:00',
    usuario_nombre: 'Ana <Admin>',
    detalle: '1 x Hamburguesa'
  },
  {
    id_reversion: 12,
    codigo_reversion: 'REV-12',
    id_factura_original: 82,
    codigo_venta: 'VTA-82',
    tipo_reversion: 'TOTAL',
    resultado_acumulado: 'TOTAL',
    motivo: 'CLIENTE_CANCELO',
    observacion: null,
    monto_reversado: '74.50',
    creada_en: '2026-07-29 15:00:00',
    usuario_nombre: 'Luis',
    detalle: '2 x Baleada'
  },
  {
    id_reversion: 13,
    codigo_reversion: 'REV-13',
    id_factura_original: 83,
    codigo_venta: 'VTA-83',
    tipo_reversion: 'PARCIAL',
    resultado_acumulado: 'TOTAL',
    motivo: 'OTRO',
    observacion: 'Completa acumuladamente',
    monto_reversado: '10.00',
    creada_en: '2026-07-29 16:00:00',
    usuario_nombre: 'Marta',
    detalle: '1 x Refresco'
  }
];

const redemptionRows = [
  {
    id_canje: 5,
    total_puntos: 40,
    fecha_creacion: '2026-07-29 14:30:00',
    estado_codigo: 'ENTREGADO',
    cliente_nombre: 'Comercial Uno',
    usuario_nombre: 'Cajero Uno',
    productos: '2 x Refresco'
  },
  {
    id_canje: 6,
    total_puntos: 30,
    fecha_creacion: '2026-07-29 15:30:00',
    estado_codigo: 'ANULADO',
    cliente_nombre: 'Cliente Dos',
    usuario_nombre: 'Cajero Dos',
    productos: '1 x Postre'
  }
];

const createSectionsRunner = ({ reversions = reversalRows, redemptions = redemptionRows } = {}) => {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('FROM public.facturas_reversiones fr')) return { rows: reversions };
      if (String(sql).includes('FROM public.fidelizacion_canjes fc')) return { rows: redemptions };
      throw new Error(`Consulta inesperada: ${String(sql).slice(0, 80)}`);
    }
  };
};

const basePayload = (sections) => ({
  idCierreCaja: '90',
  idSesionCaja: '8001',
  generatedAt: '2026-07-29 17:00:00',
  fechaCierre: '2026-07-29 17:00:00',
  session: {
    id_caja: 1,
    id_sucursal: 1,
    id_usuario_responsable: 7,
    codigo_caja: 'CJ-1',
    nombre_caja: 'Caja principal',
    nombre_sucursal: 'Centro'
  },
  actors: {
    responsable_nombre: 'Responsable',
    cierre_nombre: 'Administrador'
  },
  montoApertura: 100,
  ventasEfectivoNetas: 150,
  ventasNoEfectivoNetas: 80,
  ingresosManuales: 20,
  egresosManuales: 10,
  montoTeorico: 340,
  montoDeclaradoCierre: 340,
  diferencia: 0,
  resolutionCode: 'CAJA_CUADRA',
  requiresAudit: false,
  payrollSync: { reason: 'NOT_REQUIRED' },
  payrollSyncLabel: 'No requerido',
  arqueos: [],
  movimientosManuales: { ingresos: [], egresos: [] },
  ...sections
});

describe('Fase 6 - snapshot compartido de reversiones y canjes', () => {
  it('usa exclusivamente sesion original + APLICADA para reversiones, sin fecha/sucursal/usuario inferidos', async () => {
    const runner = createSectionsRunner();
    await loadCajaCloseReportSections({ queryRunner: runner, idSesionCaja: '8001' });
    const sql = runner.calls[0].sql;
    assert.match(sql, /fr\.id_sesion_caja_original = \$1::bigint/);
    assert.match(sql, /UPPER\(TRIM\(COALESCE\(fr\.estado, ''\)\)\) = 'APLICADA'/);
    assert.doesNotMatch(sql, /fr\.id_sucursal\s*=\s*\$1/);
    assert.doesNotMatch(sql, /fr\.creada_en\s*(?:BETWEEN|>=|<=)/);
    assert.doesNotMatch(sql, /fr\.id_sesion_caja_actual\s*=/);
    assert.deepEqual(runner.calls[0].params, ['8001']);
  });

  it('resume parcial, total, varias reversiones y conserva el resultado acumulado seguro', async () => {
    const sections = await loadCajaCloseReportSections({
      queryRunner: createSectionsRunner(),
      idSesionCaja: '8001'
    });
    assert.deepEqual(sections.reversiones.resumen, {
      cantidad_parciales: 2,
      cantidad_totales: 1,
      monto_total_reversado: 110
    });
    assert.equal(sections.reversiones.items[2].tipo, 'PARCIAL');
    assert.equal(sections.reversiones.items[2].resultado_acumulado, 'TOTAL');
    assert.equal(sections.reversiones.items[0].detalle, '1 x Hamburguesa');
  });

  it('cierre sin reversiones produce resumen cero y mensaje vacio en correo', async () => {
    const sections = await loadCajaCloseReportSections({
      queryRunner: createSectionsRunner({ reversions: [] }),
      idSesionCaja: '8001'
    });
    assert.equal(sections.reversiones.items.length, 0);
    assert.equal(sections.reversiones.resumen.monto_total_reversado, 0);
    assert.match(
      buildCajaCloseEmailHtml({ payload: basePayload(sections) }),
      /Sin reversiones de venta registradas en esta sesion/
    );
  });

  it('canjes usan exclusivamente id_sesion_caja; NULL, otra sesion y fechas no se infieren', async () => {
    const runner = createSectionsRunner();
    await loadCajaCloseReportSections({ queryRunner: runner, idSesionCaja: '8001' });
    const sql = runner.calls[1].sql;
    assert.match(sql, /fc\.id_sesion_caja = \$1::bigint/);
    assert.doesNotMatch(sql, /fc\.id_sucursal\s*=\s*\$1/);
    assert.doesNotMatch(sql, /fc\.fecha_creacion\s*(?:BETWEEN|>=|<=)/);
    assert.doesNotMatch(sql, /fc\.id_usuario_ejecutor\s*=\s*\$1/);
  });

  it('agrega productos, identifica ANULADO y excluye sus puntos del total canjeado', async () => {
    const sections = await loadCajaCloseReportSections({
      queryRunner: createSectionsRunner(),
      idSesionCaja: '8001'
    });
    assert.deepEqual(sections.canjes_fidelizacion.resumen, {
      cantidad_canjes: 2,
      cantidad_anulados: 1,
      total_puntos_canjeados: 40
    });
    assert.equal(sections.canjes_fidelizacion.items[0].productos, '2 x Refresco');
    assert.equal(sections.canjes_fidelizacion.items[1].estado, 'ANULADO');
  });

  it('canjes son informativos: no consultan movimientos ni alteran valores financieros', async () => {
    const withoutCanjes = basePayload({
      reversiones: { resumen: {}, items: [] },
      canjes_fidelizacion: { resumen: {}, items: [] }
    });
    const withCanjes = basePayload({
      reversiones: { resumen: {}, items: [] },
      canjes_fidelizacion: {
        resumen: { cantidad_canjes: 2, total_puntos_canjeados: 40 },
        items: redemptionRows
      }
    });
    const financialKeys = [
      'ventasEfectivoNetas',
      'ventasNoEfectivoNetas',
      'ingresosManuales',
      'egresosManuales',
      'montoTeorico',
      'montoDeclaradoCierre',
      'diferencia'
    ];
    assert.deepEqual(
      Object.fromEntries(financialKeys.map((key) => [key, withoutCanjes[key]])),
      Object.fromEntries(financialKeys.map((key) => [key, withCanjes[key]]))
    );
    const runner = createSectionsRunner();
    await loadCajaCloseReportSections({ queryRunner: runner, idSesionCaja: '8001' });
    assert.ok(runner.calls.every(({ sql }) => !/cajas_movimientos|facturas_cobros/.test(sql)));
  });

  it('HTML escapa motivo/nombres y nunca contiene telefono, correo, identidad o direccion', async () => {
    const sections = await loadCajaCloseReportSections({
      queryRunner: createSectionsRunner(),
      idSesionCaja: '8001'
    });
    const html = buildCajaCloseEmailHtml({ payload: basePayload(sections) });
    assert.match(html, /ERROR &lt;digitacion&gt;/);
    assert.match(html, /Ana &lt;Admin&gt;/);
    assert.doesNotMatch(html, /9999-9999|cliente@example|identidad|direccion/i);
  });

  it('correo y PDF consumen exactamente las mismas filas y totales, incluso con muchas filas', async () => {
    const sections = await loadCajaCloseReportSections({
      queryRunner: createSectionsRunner(),
      idSesionCaja: '8001'
    });
    sections.reversiones.items = Array.from({ length: 45 }, (_, index) => ({
      ...sections.reversiones.items[index % sections.reversiones.items.length],
      id_reversion: String(index + 1),
      codigo_reversion: `REV-${index + 1}`
    }));
    sections.reversiones.resumen = {
      cantidad_parciales: 30,
      cantidad_totales: 15,
      monto_total_reversado: 1650
    };
    const payload = basePayload(sections);
    const html = buildCajaCloseEmailHtml({ payload });
    const definition = buildCajaCierrePdfDefinition(payload);
    const contentText = JSON.stringify(definition.content);
    assert.match(html, /Parciales: <strong>30<\/strong>/);
    assert.match(html, /L 1,650\.00/);
    assert.match(contentText, /Parciales: 30 \| Totales: 15 \| Monto total: L 1,650\.00/);
    assert.equal((html.match(/REV-\d+/g) || []).length, 45);
    assert.equal((contentText.match(/REV-\d+/g) || []).length, 45);
    const pdf = await buildCajaCierrePdfBuffer(payload);
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(pdf.length > 5000);
  });

  it('payload durable persiste ambas secciones y el worker no consulta datos mutables', async () => {
    const sections = await loadCajaCloseReportSections({
      queryRunner: createSectionsRunner(),
      idSesionCaja: '8001'
    });
    const payload = basePayload(sections);
    let insertedPayload = null;
    const client = {
      async query(sql, params) {
        assert.match(String(sql), /payload_snapshot/);
        insertedPayload = JSON.parse(params[2]);
        return { rows: [{ id_notificacion: 1, payload_snapshot: insertedPayload }] };
      }
    };
    await createCajaCloseEmailNotification(client, {
      idCierreCaja: '90',
      emailDestino: 'admin@example.com',
      payload
    });
    assert.deepEqual(insertedPayload.reversiones, sections.reversiones);
    assert.deepEqual(insertedPayload.canjes_fidelizacion, sections.canjes_fidelizacion);

    let sentHtml = '';
    let pdfPayload = null;
    await sendCajaCloseEmailFromOutbox(
      {
        id_notificacion: 1,
        id_cierre_caja: '90',
        email_destino: 'admin@example.com',
        payload_snapshot: insertedPayload
      },
      {
        queryRunner: {
          async query() {
            throw new Error('El worker no debe consultar datos mutables con snapshot durable.');
          }
        },
        buildPdf: async (received) => {
          pdfPayload = received;
          return Buffer.from('%PDF-test');
        },
        buildPdfFilename: () => 'cierre.pdf',
        sendEmail: async (_to, _subject, html) => {
          sentHtml = html;
          return { messageId: 'msg-1' };
        }
      }
    );
    assert.equal(pdfPayload, insertedPayload);
    assert.match(sentHtml, /REV-11/);
    assert.match(sentHtml, /CAN-00005/);
  });

  it('la migracion versionada agrega payload_snapshot nullable y el backend falla controlado si falta', async () => {
    const safeSql = readFileSync(
      new URL('../../sql/20260729_caja_close_email_payload_snapshot_SAFE.sql', import.meta.url),
      'utf8'
    );
    assert.match(safeSql, /ADD COLUMN IF NOT EXISTS payload_snapshot JSONB NULL/i);
    assert.doesNotMatch(safeSql, /\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/i);
    await assert.rejects(
      createCajaCloseEmailNotification(
        {
          async query() {
            throw Object.assign(new Error('column does not exist'), { code: '42703' });
          }
        },
        {
          idCierreCaja: '90',
          payload: basePayload({
            reversiones: { resumen: {}, items: [] },
            canjes_fidelizacion: { resumen: {}, items: [] }
          })
        }
      ),
      (error) =>
        error.code === 'CAJA_CLOSE_EMAIL_SNAPSHOT_SCHEMA_PENDIENTE'
        && error.httpStatus === 409
    );
  });
});
