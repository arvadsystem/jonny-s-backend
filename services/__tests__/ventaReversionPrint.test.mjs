import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  buildVentaReversionTicketModel,
  buildVentaReversionTicketPdfBuffer
} from '../ventaReversionTicketPdfService.js';
import {
  createCanonicalPrintJob,
  validateCanonicalPrintPayload
} from '../printJobDocumentService.js';
import { enqueuePrintJobInTransaction } from '../printQueueService.js';
import {
  buildVentaReversionPrintStatus,
  enqueueAutomaticVentaReversionPrintJob
} from '../ventaReversionPrintService.js';
import { enqueueVentaReversionPrintJob } from '../../routers/printing.js';
import { validateCanonicalPrintJobData } from '../../print-agent/src/documentRenderer.js';

const baseData = (overrides = {}) => ({
  id_reversion: 41,
  codigo_reversion: 'REV-000041',
  id_factura_original: 9,
  id_sucursal: 2,
  id_caja_original: 3,
  id_sesion_caja_original: 11,
  tipo_reversion: 'PARCIAL',
  motivo: 'CLIENTE_CANCELO',
  observacion: 'Solo una linea',
  monto_reversado: 125,
  estado: 'APLICADA',
  creada_en: '2026-07-29T15:30:00.000Z',
  creada_por: 7,
  codigo_venta: 'VTA-000009',
  nombre_sucursal: 'El Carmen',
  codigo_caja: 'CJ-03',
  nombre_caja: 'Caja principal',
  nombre_usuario: 'admin',
  prefijo_reversion: 'REV',
  ancho_ticket_mm: 80,
  imprimir_comprobante_reversion: true,
  mostrar_venta_original_reversion: true,
  mostrar_codigo_reversion: true,
  mostrar_usuario_reversion: true,
  mostrar_caja_sesion_reversion: true,
  mostrar_motivo_reversion: true,
  mostrar_detalle_reversion: true,
  mostrar_total_reversion: true,
  resultado_acumulado: 'PARCIAL',
  facturacion: {
    emisor: {
      nombre_emisor: "JONNY'S EL CARMEN",
      rtn_emisor: '08011999123456',
      direccion_emisor: 'El Carmen, San Pedro Sula',
      telefono_emisor: '2500-0000',
      correo_emisor: 'facturacion@example.com',
      logo_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    },
    ticket: {
      mostrar_logo_ticket: true,
      mostrar_rtn: true,
      mostrar_direccion: true,
      mostrar_telefono: true,
      mostrar_correo: true,
      texto_encabezado_ticket: 'Gracias por su compra'
    }
  },
  lineas: [
    {
      id_reversion_detalle: 1,
      id_detalle_factura: 10,
      nombre_item: 'Alitas 6 piezas',
      cantidad_revertida: 1,
      precio_unitario_original: 125,
      total_revertido: 125
    }
  ],
  ...overrides
});

describe('comprobante canonico de reversion', () => {
  it('reutiliza logo, restaurante y campos del encabezado de la factura', () => {
    const model = buildVentaReversionTicketModel(baseData());
    assert.equal(model.branding.nombre, "JONNY'S EL CARMEN");
    assert.equal(model.branding.rtn, '08011999123456');
    assert.equal(model.branding.direccion, 'El Carmen, San Pedro Sula');
    assert.equal(model.branding.telefono, '2500-0000');
    assert.equal(model.branding.correo, 'facturacion@example.com');
    assert.equal(model.branding.textoEncabezado, 'Gracias por su compra');
    assert.ok(Buffer.isBuffer(model.branding.logo));
  });

  it('respeta las banderas visuales del encabezado de facturacion', () => {
    const model = buildVentaReversionTicketModel(baseData({
      facturacion: {
        emisor: baseData().facturacion.emisor,
        ticket: {
          mostrar_logo_ticket: false,
          mostrar_rtn: false,
          mostrar_direccion: false,
          mostrar_telefono: false,
          mostrar_correo: false
        }
      }
    }));
    assert.equal(model.branding.logo, null);
    assert.equal(model.branding.rtn, null);
    assert.equal(model.branding.direccion, null);
    assert.equal(model.branding.telefono, null);
    assert.equal(model.branding.correo, null);
  });

  it('una parcial contiene solo las lineas de esa operacion', () => {
    const model = buildVentaReversionTicketModel(baseData());
    assert.equal(model.lines.length, 1);
    assert.equal(model.lines[0].name, 'Alitas 6 piezas');
    assert.equal(model.fields.find((field) => field.label === 'Resultado acumulado').value, 'PARCIAL');
  });

  it('una total imprime las cantidades restantes de esa operacion y resultado TOTAL', () => {
    const model = buildVentaReversionTicketModel(baseData({
      tipo_reversion: 'TOTAL',
      resultado_acumulado: 'TOTAL',
      lineas: [
        { nombre_item: 'Combo familiar', cantidad_revertida: 2, precio_unitario_original: 200, total_revertido: 400 }
      ]
    }));
    assert.equal(model.lines[0].quantity, '2');
    assert.equal(model.fields.find((field) => field.label === 'Resultado acumulado').value, 'TOTAL');
  });

  it('una parcial que completa la factura indica resultado TOTAL', () => {
    const model = buildVentaReversionTicketModel(baseData({ resultado_acumulado: 'TOTAL' }));
    assert.equal(model.fields.find((field) => field.label === 'Tipo solicitado').value, 'PARCIAL');
    assert.equal(model.fields.find((field) => field.label === 'Resultado acumulado').value, 'TOTAL');
  });

  it('genera PDF valido en 58 mm y 80 mm', async () => {
    const expectedMetrics = {
      58: { leftMm: 4, rightMm: 5, usableWidthMm: 47.5 },
      80: { leftMm: 7, rightMm: 10, usableWidthMm: 61.5 }
    };
    for (const width of [58, 80]) {
      const pdf = await buildVentaReversionTicketPdfBuffer(baseData({ ancho_ticket_mm: width }));
      assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
      assert.ok(pdf.length > 500);
      assert.equal(buildVentaReversionTicketModel(baseData({ ancho_ticket_mm: width })).widthMm, width);
      const pdfText = pdf.toString('latin1');
      const mediaBox = pdfText.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
      assert.ok(mediaBox, `PDF ${width} mm debe declarar MediaBox`);
      assert.ok(Math.abs(Number(mediaBox[1]) - ((width * 72) / 25.4)) < 0.01);
      const divider = pdfText.match(/([\d.]+)\s+[\d.]+\s+m\s+([\d.]+)\s+[\d.]+\s+l/);
      assert.ok(divider, `PDF ${width} mm debe declarar separadores dentro del ancho util`);
      const leftPt = (expectedMetrics[width].leftMm * 72) / 25.4;
      const usableWidthPt = (expectedMetrics[width].usableWidthMm * 72) / 25.4;
      assert.ok(Math.abs(Number(divider[1]) - leftPt) < 0.01);
      assert.ok(Math.abs((Number(divider[2]) - Number(divider[1])) - usableWidthPt) < 0.01);
      const physicalRightMarginMm = width - expectedMetrics[width].leftMm - expectedMetrics[width].usableWidthMm;
      assert.equal(physicalRightMarginMm, expectedMetrics[width].rightMm + 1.5);
    }
  });

  it('rechaza anchos distintos de 58 mm y 80 mm', () => {
    assert.throws(
      () => buildVentaReversionTicketModel(baseData({ ancho_ticket_mm: 59 })),
      (error) => error.code === 'VENTA_REVERSION_TICKET_WIDTH_INVALID'
    );
  });

  it('respeta todos los campos ocultos por configuracion', () => {
    const model = buildVentaReversionTicketModel(baseData({
      mostrar_venta_original_reversion: false,
      mostrar_codigo_reversion: false,
      mostrar_usuario_reversion: false,
      mostrar_caja_sesion_reversion: false,
      mostrar_motivo_reversion: false,
      mostrar_detalle_reversion: false,
      mostrar_total_reversion: false
    }));
    const labels = model.fields.map((field) => field.label);
    assert.equal(labels.includes('Venta original'), false);
    assert.equal(labels.includes('Codigo REV'), false);
    assert.equal(labels.includes('Usuario'), false);
    assert.equal(labels.includes('Caja / sesion'), false);
    assert.equal(labels.includes('Motivo'), false);
    assert.equal(model.showDetail, false);
    assert.equal(model.lines.length, 0);
    assert.equal(model.total, null);
  });

  it('usa tipo_documento=reversion, impresora logica factura y fuente id_reversion', async () => {
    const canonical = await createCanonicalPrintJob({
      tipoDocumento: 'reversion',
      venta: baseData(),
      widthMm: 80
    });
    assert.equal(canonical.payload.tipo_documento, 'reversion');
    assert.equal(canonical.payload.impresora_logica, 'factura');
    assert.equal(canonical.payload.documento_canonico.kind, 'venta_reversion_ticket_pdf');
    assert.equal(canonical.payload.source.id_reversion, 41);
    assert.deepEqual(canonical.document.options, {
      altFontRendering: true,
      ignoreTransparency: true
    });
    assert.equal(Object.hasOwn(canonical.document.options, 'pageWidth'), false);
    assert.equal(validateCanonicalPrintPayload(canonical.payload).ok, true);
    assert.deepEqual(
      validateCanonicalPrintJobData(canonical.payload, canonical.document),
      canonical.document
    );
  });
});

describe('cola durable de reversion', () => {
  it('expone estado estable con id real cuando la impresion automatica esta habilitada', () => {
    assert.deepEqual(
      buildVentaReversionPrintStatus({
        enabled: true,
        job: { id_trabajo: 71, estado: 'pendiente', tipo_documento: 'reversion' }
      }),
      {
        automatica_habilitada: true,
        trabajo_creado: true,
        id_trabajo: 71,
        estado: 'PENDIENTE',
        tipo_documento: 'reversion',
        impresora_logica: 'factura'
      }
    );
  });

  it('expone estado estable y sin trabajo cuando la impresion automatica esta deshabilitada', () => {
    assert.deepEqual(
      buildVentaReversionPrintStatus({ enabled: false, job: null }),
      {
        automatica_habilitada: false,
        trabajo_creado: false,
        id_trabajo: null,
        estado: 'DESHABILITADA',
        tipo_documento: 'reversion',
        impresora_logica: 'factura'
      }
    );
  });

  const createTransactionalMock = ({ schemaError = null } = {}) => {
    const state = { job: null, documents: 0, sql: [] };
    return {
      state,
      client: {
        async query(sql) {
          const text = String(sql);
          state.sql.push(text);
          if (text.includes('INSERT INTO public.trabajos_impresion (')) {
            if (schemaError) throw Object.assign(new Error('schema'), { code: schemaError });
            if (state.job) return { rows: [] };
            state.job = {
              id_trabajo: 71,
              id_sucursal: 2,
              tipo_documento: 'reversion',
              estado: 'pendiente'
            };
            return { rows: [state.job] };
          }
          if (text.includes('FROM public.trabajos_impresion')) return { rows: state.job ? [state.job] : [] };
          if (text.includes('INSERT INTO public.trabajos_impresion_documentos')) {
            state.documents += 1;
            return { rows: [] };
          }
          throw new Error(`SQL no simulado: ${text}`);
        }
      }
    };
  };

  it('encola dentro del client recibido sin BEGIN/COMMIT e idempotencia inicial', async () => {
    const canonical = await createCanonicalPrintJob({
      tipoDocumento: 'reversion',
      venta: baseData(),
      widthMm: 80
    });
    const mock = createTransactionalMock();
    const params = {
      client: mock.client,
      idSucursal: 2,
      tipoDocumento: 'reversion',
      payload: canonical.payload,
      canonicalDocument: canonical.document,
      idempotencyKey: 'reversion:41:inicial',
      idFactura: 9,
      idReversion: 41,
      idUsuario: 7
    };
    const first = await enqueuePrintJobInTransaction(params);
    const replay = await enqueuePrintJobInTransaction(params);
    assert.equal(first.id_trabajo, replay.id_trabajo);
    assert.equal(mock.state.documents, 1);
    assert.equal(mock.state.sql.some((sql) => /^\s*(BEGIN|COMMIT)\b/i.test(sql)), false);
  });

  it('schema pendiente produce PRINTING_REVERSION_SCHEMA_PENDIENTE 409', async () => {
    const canonical = await createCanonicalPrintJob({
      tipoDocumento: 'reversion',
      venta: baseData(),
      widthMm: 80
    });
    const mock = createTransactionalMock({ schemaError: '42703' });
    await assert.rejects(
      enqueuePrintJobInTransaction({
        client: mock.client,
        idSucursal: 2,
        tipoDocumento: 'reversion',
        payload: canonical.payload,
        canonicalDocument: canonical.document,
        idempotencyKey: 'reversion:41:inicial',
        idFactura: 9,
        idReversion: 41,
        idUsuario: 7
      }),
      (error) => error.code === 'PRINTING_REVERSION_SCHEMA_PENDIENTE'
        && error.httpStatus === 409
    );
  });

  it('automatico habilitado encola; deshabilitado no crea trabajo', async () => {
    const calls = [];
    const dependencies = {
      client: { query: async () => ({ rows: [] }) },
      idReversion: 41,
      idFactura: 9,
      idSucursal: 2,
      idUsuario: 7,
      createDocument: async () => ({ payload: {}, document: {} }),
      enqueue: async (params) => {
        calls.push(params);
        return { id_trabajo: 1 };
      }
    };
    const enabled = await enqueueAutomaticVentaReversionPrintJob({
      ...dependencies,
      loadReversion: async () => baseData()
    });
    const disabled = await enqueueAutomaticVentaReversionPrintJob({
      ...dependencies,
      loadReversion: async () => baseData({ imprimir_comprobante_reversion: false })
    });
    assert.equal(enabled.enabled, true);
    assert.equal(disabled.enabled, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].idempotencyKey, 'reversion:41:inicial');
  });

  it('agente apagado o impresora fisica ausente no se consultan durante la transaccion', async () => {
    const source = readFileSync(new URL('../ventaReversionPrintService.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /qz|websocket|printerMap|notifyPrintJobAvailable/i);
    assert.match(source, /enqueuePrintJobInTransaction/);
  });

  it('persiste el id de impresion en la respuesta idempotente antes del COMMIT', () => {
    const source = readFileSync(new URL('../ventasReversionService.js', import.meta.url), 'utf8');
    const statusIndex = source.indexOf('result.impresion = buildVentaReversionPrintStatus(printResult)');
    const responseIndex = source.indexOf('const responseBody =', statusIndex);
    const saveIndex = source.indexOf('idempotency.saveSuccess', responseIndex);
    const commitIndex = source.indexOf("client.query('COMMIT')", saveIndex);
    assert.ok(statusIndex > 0);
    assert.ok(responseIndex > statusIndex);
    assert.ok(saveIndex > responseIndex);
    assert.ok(commitIndex > saveIndex);
  });
});

describe('endpoint de reimpresion y agente', () => {
  it('cada reimpresion crea una clave UUID nueva y mantiene impresora logica factura', async () => {
    const calls = [];
    let uuid = 0;
    const common = {
      req: { user: { id_usuario: 7 } },
      idReversion: 41,
      queryRunner: {},
      loadReversion: async () => baseData(),
      resolveScope: async () => ({ isSuperAdmin: true, allowedSucursalIds: [] }),
      createPayload: async ({ tipoDocumento, venta, widthMm }) =>
        createCanonicalPrintJob({ tipoDocumento, venta, widthMm }),
      enqueue: async (params) => {
        calls.push(params);
        return { id_trabajo: calls.length };
      },
      createUuid: () => `uuid-${++uuid}`
    };
    await enqueueVentaReversionPrintJob(common);
    await enqueueVentaReversionPrintJob(common);
    assert.equal(calls[0].idempotencyKey, 'reversion:41:reprint:uuid-1');
    assert.equal(calls[1].idempotencyKey, 'reversion:41:reprint:uuid-2');
    assert.equal(calls[0].tipoDocumento, 'reversion');
    assert.equal(calls[0].payload.impresora_logica, 'factura');
    assert.equal(calls[0].idReversion, 41);
  });

  it('el agente acepta reversion como PDF y la enruta a factura sin crear REVERSION fisica', () => {
    const rendererSource = readFileSync(
      new URL('../../print-agent/src/documentRenderer.js', import.meta.url),
      'utf8'
    );
    const configSource = readFileSync(new URL('../../print-agent/src/config.js', import.meta.url), 'utf8');
    assert.match(rendererSource, /reversion:[\s\S]*impresoraLogica: 'factura'/);
    assert.doesNotMatch(configSource, /reversion\s*:/i);
  });
});
