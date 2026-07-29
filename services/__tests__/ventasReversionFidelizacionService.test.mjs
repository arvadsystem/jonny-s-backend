// Fase 4: pruebas de applyLoyaltyReversalForFactura (reversion de puntos
// de fidelizacion por reversion de venta) y de su calculo puro
// computeLoyaltyReversalTarget.
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  applyLoyaltyReversalForFactura,
  computeLoyaltyReversalTarget,
  resolveLoyaltySourceMovement,
  __resetVentasReversionFidelizacionSchemaProbeCacheForTests
} from '../../routers/ventas/services/ventasReversionFidelizacionService.js';

beforeEach(() => {
  __resetVentasReversionFidelizacionSchemaProbeCacheForTests();
});

const REVERSE_CATALOG_ROW = {
  type: { id_catalogo: 3, estado: true },
  origin: { id_catalogo: 3, estado: true }
};

const createLoyaltyMockClient = ({
  sourceMovements = [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 100 }],
  reverseCatalogRow = REVERSE_CATALOG_ROW,
  alreadyReversedPoints = 0,
  montoReversadoAcumulado = 0,
  saldo = { id_cliente: 5, puntos_disponibles: 100, puntos_acumulados_total: 100, puntos_canjeados_total: 0 },
  hasIdReversionColumn = true,
  hasAjustesPendientesTable = true,
  existingAdjustment = null
} = {}) => {
  const inserted = [];
  const updates = { saldo: [], clientes: [], movimientosReverso: [], ajustesPendientes: [] };
  const ajustesInsertados = [];
  const adjustmentByReversion = new Map(
    existingAdjustment ? [[Number(existingAdjustment.id_reversion), { ...existingAdjustment }]] : []
  );
  let saldoState = { ...saldo };

  const client = {
    async query(sql, params = []) {
      const text = String(sql);

      if (/FROM public\.fidelizacion_movimientos fm[\s\S]*puntos_delta > 0/.test(text)) {
        return { rowCount: sourceMovements.length, rows: sourceMovements };
      }

      if (/FROM public\.cat_fidelizacion_tipos_movimiento/.test(text)) {
        const rows = reverseCatalogRow?.types || (reverseCatalogRow?.type ? [reverseCatalogRow.type] : []);
        return { rowCount: rows.length, rows };
      }
      if (/FROM public\.cat_fidelizacion_origenes_movimiento/.test(text)) {
        const rows = reverseCatalogRow?.origins || (reverseCatalogRow?.origin ? [reverseCatalogRow.origin] : []);
        return { rowCount: rows.length, rows };
      }

      if (/SUM\(monto_reversado\)/.test(text)) {
        return { rows: [{ monto_reversado_acumulado: montoReversadoAcumulado }] };
      }

      if (/SUM\(ABS\(fm\.puntos_delta\)\)/.test(text)) {
        return { rows: [{ puntos_revertidos: alreadyReversedPoints }] };
      }

      // getClienteSaldoForUpdate (real, importado de fidelizacionService.js):
      // ensureSaldoRow hace INSERT ... ON CONFLICT DO NOTHING primero.
      if (/INSERT INTO public\.fidelizacion_saldos_cliente/.test(text)) {
        return { rows: [] };
      }
      if (/FROM public\.fidelizacion_saldos_cliente[\s\S]*FOR UPDATE/.test(text)) {
        return { rows: [{ ...saldoState }] };
      }
      if (/UPDATE public\.fidelizacion_saldos_cliente/.test(text)) {
        const [disponibles] = params;
        saldoState = { ...saldoState, puntos_disponibles: Number(disponibles) };
        updates.saldo.push({ disponibles: Number(disponibles), acumulados: saldoState.puntos_acumulados_total });
        return { rows: [] };
      }
      if (/UPDATE public\.clientes/.test(text)) {
        updates.clientes.push(params);
        return { rows: [] };
      }

      // hasColumn(fidelizacion_movimientos, id_reversion)
      if (/information_schema\.columns[\s\S]*column_name = \$2/.test(text)) {
        return { rowCount: hasIdReversionColumn ? 1 : 0, rows: hasIdReversionColumn ? [{ x: 1 }] : [] };
      }
      // hasTable(fidelizacion_ajustes_pendientes)
      if (/SELECT to_regclass\(\$1\)/.test(text)) {
        return { rows: [{ reg: hasAjustesPendientesTable ? 'fidelizacion_ajustes_pendientes' : null }] };
      }

      if (/INSERT INTO public\.fidelizacion_movimientos[\s\S]*id_reversion/.test(text) && hasIdReversionColumn) {
        const idMovimiento = inserted.length + 100;
        inserted.push({ params, idMovimiento });
        updates.movimientosReverso.push(params);
        return { rows: [{ id_movimiento: idMovimiento }] };
      }

      if (/SELECT id_movimiento, puntos_delta[\s\S]*FOR UPDATE/.test(text)) {
        return existingLegacyReverseRow ? { rowCount: 1, rows: [existingLegacyReverseRow] } : { rowCount: 0, rows: [] };
      }
      if (/UPDATE public\.fidelizacion_movimientos/.test(text)) {
        updates.movimientosReverso.push(params);
        return { rows: [] };
      }
      if (/INSERT INTO public\.fidelizacion_movimientos/.test(text)) {
        const idMovimiento = inserted.length + 100;
        inserted.push({ params, idMovimiento });
        updates.movimientosReverso.push(params);
        return { rows: [{ id_movimiento: idMovimiento }] };
      }

      if (/INSERT INTO public\.fidelizacion_ajustes_pendientes/.test(text)) {
        const idReversion = Number(params[2]);
        if (adjustmentByReversion.has(idReversion)) return { rows: [] };
        const idAjuste = ajustesInsertados.length + 1;
        ajustesInsertados.push({ params, idAjuste });
        updates.ajustesPendientes.push(params);
        adjustmentByReversion.set(idReversion, {
          id_ajuste: idAjuste,
          id_cliente: Number(params[0]),
          id_factura: Number(params[1]),
          id_reversion: idReversion,
          puntos_objetivo: Number(params[3]),
          puntos_recuperados: Number(params[4]),
          puntos_pendientes: Number(params[5])
        });
        return { rows: [{ id_ajuste: idAjuste }] };
      }
      if (/FROM public\.fidelizacion_ajustes_pendientes[\s\S]*WHERE id_reversion = \$1[\s\S]*FOR UPDATE/.test(text)) {
        const row = adjustmentByReversion.get(Number(params[0]));
        return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
      }

      throw new Error(`Consulta no simulada en mock de reversion de fidelizacion: ${text}`);
    }
  };

  return { client, inserted, updates, ajustesInsertados, get saldoState() { return saldoState; } };
};

describe('computeLoyaltyReversalTarget (seccion 3.2)', () => {
  it('proporcion normal (no completa la factura): floor(originales * montoAcumulado / total)', () => {
    const objetivo = computeLoyaltyReversalTarget({
      puntosOriginales: 100,
      montoReversadoAcumulado: 300,
      totalOriginalFactura: 1000,
      puntosRevertidosAnteriores: 0,
      facturaTotalmenteReversada: false
    });
    assert.equal(objetivo, 30);
  });

  it('cuando factura queda totalmente reversada (resultado ACUMULADO real), absorbe el remanente exacto sin importar el prorrateo', () => {
    const objetivo = computeLoyaltyReversalTarget({
      puntosOriginales: 100,
      montoReversadoAcumulado: 999, // deliberadamente no usado en esta rama
      totalOriginalFactura: 1000,
      puntosRevertidosAnteriores: 37,
      facturaTotalmenteReversada: true
    });
    assert.equal(objetivo, 63);
  });

  it('no depende de tipo_reversion=TOTAL: una PARCIAL que agota la ultima unidad se comporta igual que TOTAL', () => {
    // Simula el ejemplo del ticket: PARCIAL que completa la factura.
    const objetivo = computeLoyaltyReversalTarget({
      puntosOriginales: 50,
      montoReversadoAcumulado: 1,
      totalOriginalFactura: 1000,
      puntosRevertidosAnteriores: 0,
      facturaTotalmenteReversada: true
    });
    assert.equal(objetivo, 50, 'debe absorber TODO, no solo la proporcion minima del monto');
  });
});

describe('resolveLoyaltySourceMovement (seccion 3.1)', () => {
  it('0 movimientos fuente -> null (NO_GENERO_PUNTOS)', async () => {
    const { client } = createLoyaltyMockClient({ sourceMovements: [] });
    const result = await resolveLoyaltySourceMovement(client, 900);
    assert.equal(result, null);
  });

  it('1) 2+ movimientos fuente -> VENTAS_REVERSION_FIDELIZACION_AMBIGUA', async () => {
    const { client } = createLoyaltyMockClient({
      sourceMovements: [
        { id_movimiento: 1, id_cliente: 5, puntos_delta: 50 },
        { id_movimiento: 2, id_cliente: 5, puntos_delta: 30 }
      ]
    });
    await assert.rejects(
      resolveLoyaltySourceMovement(client, 900),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'VENTAS_REVERSION_FIDELIZACION_AMBIGUA');
        return true;
      }
    );
  });
});

describe('applyLoyaltyReversalForFactura', () => {
  it('1) factura sin puntos -> NO_GENERO_PUNTOS, sin error', async () => {
    const { client, inserted } = createLoyaltyMockClient({ sourceMovements: [] });
    const result = await applyLoyaltyReversalForFactura({
      client, idFactura: 900, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
      idReversion: 1, codigoReversion: 'REV-1', totalFactura: 1000, facturaTotalmenteReversada: true
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'NO_GENERO_PUNTOS');
    assert.equal(inserted.length, 0);
  });

  it('2) reversion PARCIAL: objetivo proporcional, puntos suficientes -> se retiran exactamente esos puntos', async () => {
    const { client, updates } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 100 }],
      montoReversadoAcumulado: 250,
      saldo: { id_cliente: 5, puntos_disponibles: 100, puntos_acumulados_total: 100, puntos_canjeados_total: 0 }
    });
    const result = await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'PARCIAL',
      idReversion: 10, codigoReversion: 'REV-10', totalFactura: 1000, facturaTotalmenteReversada: false
    });
    assert.equal(result.applied, true);
    assert.equal(result.puntos_objetivo, 25);
    assert.equal(result.puntos_revertidos, 25);
    assert.equal(result.saldo_nuevo, 75);
    assert.equal(updates.movimientosReverso.length, 1);
  });

  it('3) varias parciales sucesivas: cada una usa el resultado acumulado real (facturaTotalmenteReversada) para su propio objetivo', async () => {
    const { client: client1 } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 90 }],
      montoReversadoAcumulado: 300, alreadyReversedPoints: 0
    });
    const op1 = await applyLoyaltyReversalForFactura({
      client: client1, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'PARCIAL',
      idReversion: 20, codigoReversion: 'REV-20', totalFactura: 900, facturaTotalmenteReversada: false
    });
    assert.equal(op1.puntos_objetivo, 30);

    const { client: client2 } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 90 }],
      montoReversadoAcumulado: 600, alreadyReversedPoints: 30
    });
    const op2 = await applyLoyaltyReversalForFactura({
      client: client2, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'PARCIAL',
      idReversion: 21, codigoReversion: 'REV-21', totalFactura: 900, facturaTotalmenteReversada: false
    });
    // objetivoAcumulado = floor(90*600/900) = 60; puntosOperacion = 60-30 = 30.
    assert.equal(op2.puntos_objetivo, 30);
  });

  it('4) ultima parcial absorbe el residuo completo (facturaTotalmenteReversada=true en la operacion final)', async () => {
    const { client } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 100 }],
      alreadyReversedPoints: 33 // dos parciales previas ya retiraron 33
    });
    const result = await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'PARCIAL',
      idReversion: 22, codigoReversion: 'REV-22', totalFactura: 1000, facturaTotalmenteReversada: true
    });
    assert.equal(result.puntos_objetivo, 67, 'debe absorber exactamente el remanente (100-33), no un nuevo prorrateo');
  });

  it('5) reversion TOTAL sin parciales previas: retira el 100% de los puntos originales', async () => {
    const { client } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 40 }]
    });
    const result = await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
      idReversion: 23, codigoReversion: 'REV-23', totalFactura: 400, facturaTotalmenteReversada: true
    });
    assert.equal(result.puntos_objetivo, 40);
    assert.equal(result.puntos_revertidos, 40);
  });

  it('6) puntos disponibles suficientes: retira el objetivo completo, sin deuda pendiente', async () => {
    const { client, ajustesInsertados } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      saldo: { id_cliente: 5, puntos_disponibles: 50, puntos_acumulados_total: 50, puntos_canjeados_total: 0 }
    });
    const result = await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
      idReversion: 24, codigoReversion: 'REV-24', totalFactura: 100, facturaTotalmenteReversada: true
    });
    assert.equal(result.puntos_revertidos, 10);
    assert.equal(result.puntos_pendientes, 0);
    assert.equal(ajustesInsertados.length, 0);
  });

  it('7-8) puntos parcialmente gastados: retira solo el saldo disponible, registra ajuste pendiente por el resto (ejemplo del ticket: objetivo 10, saldo 3 -> retira 3, pendiente 7, saldo final 0)', async () => {
    const { client, ajustesInsertados } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      saldo: { id_cliente: 5, puntos_disponibles: 3, puntos_acumulados_total: 10, puntos_canjeados_total: 7 }
    });
    const result = await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
      idReversion: 25, codigoReversion: 'REV-25', totalFactura: 100, facturaTotalmenteReversada: true
    });
    assert.equal(result.puntos_objetivo, 10);
    assert.equal(result.puntos_revertidos, 3, 'retira ahora exactamente el saldo disponible');
    assert.equal(result.puntos_pendientes, 7, 'registra el remanente como deuda pendiente');
    assert.equal(result.saldo_nuevo, 0, 'saldo nunca negativo');
    assert.equal(ajustesInsertados.length, 1);
    const [, , , puntosObjetivo, puntosRecuperados, puntosPendientes, estado] = ajustesInsertados[0].params;
    assert.equal(puntosObjetivo, 10);
    assert.equal(puntosRecuperados, 3);
    assert.equal(puntosPendientes, 7);
    assert.equal(estado, 'PARCIALMENTE_RECUPERADO');
  });

  it('8) puntos totalmente gastados (saldo=0): no retira nada ahora, pero registra el ajuste pendiente por el objetivo completo', async () => {
    const { client, ajustesInsertados, updates } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      saldo: { id_cliente: 5, puntos_disponibles: 0, puntos_acumulados_total: 10, puntos_canjeados_total: 10 }
    });
    const result = await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
      idReversion: 26, codigoReversion: 'REV-26', totalFactura: 100, facturaTotalmenteReversada: true
    });
    assert.equal(result.puntos_revertidos, 0);
    assert.equal(result.puntos_pendientes, 10);
    assert.equal(result.applied, true, 'se considera aplicado porque SI se registro la deuda, aunque el saldo no cambiara');
    assert.equal(ajustesInsertados.length, 1);
    assert.equal(ajustesInsertados[0].params[6], 'PENDIENTE');
    assert.equal(updates.movimientosReverso.length, 0, 'no debe crear un movimiento REVERSO de 0 puntos');
  });

  it('9) saldo nunca negativo: puntosAplicables se limita al saldo disponible incluso si el objetivo lo excede', async () => {
    const { client } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 1000 }],
      saldo: { id_cliente: 5, puntos_disponibles: 5, puntos_acumulados_total: 1000, puntos_canjeados_total: 995 }
    });
    const result = await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
      idReversion: 27, codigoReversion: 'REV-27', totalFactura: 10000, facturaTotalmenteReversada: true
    });
    assert.ok(result.saldo_nuevo >= 0);
    assert.equal(result.saldo_nuevo, 0);
  });

  it('10) ajuste pendiente creado dentro de la misma llamada, con id_reversion correcto', async () => {
    const { client, ajustesInsertados } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      saldo: { id_cliente: 5, puntos_disponibles: 0, puntos_acumulados_total: 10, puntos_canjeados_total: 10 }
    });
    await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
      idReversion: 555, codigoReversion: 'REV-555', totalFactura: 100, facturaTotalmenteReversada: true
    });
    assert.equal(ajustesInsertados[0].params[2], 555);
  });

  it('11) ajuste existente igual se bloquea, valida y trata como replay', async () => {
    const { client, ajustesInsertados } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      saldo: { id_cliente: 5, puntos_disponibles: 0, puntos_acumulados_total: 10, puntos_canjeados_total: 10 },
      existingAdjustment: {
        id_ajuste: 77,
        id_cliente: 5,
        id_factura: 1,
        id_reversion: 999,
        puntos_objetivo: 10,
        puntos_recuperados: 0,
        puntos_pendientes: 10
      }
    });
    const result = await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
      idReversion: 999, codigoReversion: 'REV-999', totalFactura: 100, facturaTotalmenteReversada: true
    });
    assert.equal(result.id_ajuste_pendiente, 77);
    assert.equal(ajustesInsertados.length, 0);
  });

  it('ajuste existente diferente aborta con FIDELIZACION_AJUSTE_CONFLICTO', async () => {
    const { client } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      saldo: { id_cliente: 5, puntos_disponibles: 0, puntos_acumulados_total: 10, puntos_canjeados_total: 10 },
      existingAdjustment: {
        id_ajuste: 77,
        id_cliente: 5,
        id_factura: 999,
        id_reversion: 998,
        puntos_objetivo: 10,
        puntos_recuperados: 0,
        puntos_pendientes: 10
      }
    });
    await assert.rejects(
      applyLoyaltyReversalForFactura({
        client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
        idReversion: 998, codigoReversion: 'REV-998', totalFactura: 100, facturaTotalmenteReversada: true
      }),
      (err) => err.code === 'FIDELIZACION_AJUSTE_CONFLICTO' && err.httpStatus === 409
    );
  });

  it('12) dos reversiones diferentes de la misma factura generan movimientos/registros separados (trazabilidad por id_reversion)', async () => {
    const { client, inserted } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 100 }],
      montoReversadoAcumulado: 500,
      saldo: { id_cliente: 5, puntos_disponibles: 100, puntos_acumulados_total: 100, puntos_canjeados_total: 0 }
    });
    await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'PARCIAL',
      idReversion: 30, codigoReversion: 'REV-30', totalFactura: 1000, facturaTotalmenteReversada: false
    });
    await applyLoyaltyReversalForFactura({
      client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'PARCIAL',
      idReversion: 31, codigoReversion: 'REV-31', totalFactura: 1000, facturaTotalmenteReversada: false
    });
    assert.equal(inserted.length, 2, 'cada reversion crea su propio movimiento REVERSO independiente (id_reversion), nunca actualiza uno existente');
    assert.equal(inserted[0].params[8], 30);
    assert.equal(inserted[1].params[8], 31);
  });

  it('13) sin ajustes_pendientes cuando hace falta -> FIDELIZACION_SCHEMA_PENDIENTE, sin tocar saldo ni movimiento (rollback total de la reversion)', async () => {
    const { client, updates } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      saldo: { id_cliente: 5, puntos_disponibles: 3, puntos_acumulados_total: 10, puntos_canjeados_total: 7 },
      hasAjustesPendientesTable: false
    });
    await assert.rejects(
      applyLoyaltyReversalForFactura({
        client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
        idReversion: 40, codigoReversion: 'REV-40', totalFactura: 100, facturaTotalmenteReversada: true
      }),
      (err) => {
        assert.equal(err.httpStatus, 409);
        assert.equal(err.code, 'FIDELIZACION_SCHEMA_PENDIENTE');
        return true;
      }
    );
    assert.equal(updates.saldo.length, 0, 'nunca debe tocar el saldo si luego no puede registrar la deuda');
    assert.equal(updates.movimientosReverso.length, 0);
  });

  it('catalogo REVERSO ausente aborta con FIDELIZACION_CATALOGS_ERROR', async () => {
    const { client } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      reverseCatalogRow: null
    });
    await assert.rejects(
      applyLoyaltyReversalForFactura({
        client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
        idReversion: 41, codigoReversion: 'REV-41', totalFactura: 100, facturaTotalmenteReversada: true
      }),
      (err) => err.code === 'FIDELIZACION_CATALOGS_ERROR' && err.httpStatus === 409
    );
  });

  it('catalogo REVERSO duplicado por codigo normalizado aborta por ambiguedad', async () => {
    const { client } = createLoyaltyMockClient({
      reverseCatalogRow: {
        types: [{ id_catalogo: 3, estado: true }, { id_catalogo: 4, estado: true }],
        origins: [{ id_catalogo: 3, estado: true }]
      }
    });
    await assert.rejects(
      applyLoyaltyReversalForFactura({
        client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
        idReversion: 43, codigoReversion: 'REV-43', totalFactura: 100, facturaTotalmenteReversada: true
      }),
      (err) => err.code === 'FIDELIZACION_CATALOGS_ERROR' && err.httpStatus === 409
    );
  });

  it('sin columna id_reversion en fidelizacion_movimientos -> FIDELIZACION_SCHEMA_PENDIENTE', async () => {
    const { client, updates } = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      hasIdReversionColumn: false
    });
    await assert.rejects(
      applyLoyaltyReversalForFactura({
        client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
        idReversion: 42, codigoReversion: 'REV-42', totalFactura: 100, facturaTotalmenteReversada: true
      }),
      (err) => err.code === 'FIDELIZACION_SCHEMA_PENDIENTE' && err.httpStatus === 409
    );
    assert.equal(updates.movimientosReverso.length, 0);
  });

  it('una reversion reduce disponibles pero conserva puntos_acumulados_total y puntos_canjeados_total', async () => {
    const mock = createLoyaltyMockClient({
      sourceMovements: [{ id_movimiento: 1, id_cliente: 5, puntos_delta: 10 }],
      saldo: { id_cliente: 5, puntos_disponibles: 8, puntos_acumulados_total: 123, puntos_canjeados_total: 45 }
    });
    await applyLoyaltyReversalForFactura({
      client: mock.client, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'TOTAL',
      idReversion: 44, codigoReversion: 'REV-44', totalFactura: 100, facturaTotalmenteReversada: true
    });
    assert.equal(mock.saldoState.puntos_disponibles, 0);
    assert.equal(mock.saldoState.puntos_acumulados_total, 123);
    assert.equal(mock.saldoState.puntos_canjeados_total, 45);
  });

  it('el conteo previo filtra solo REVERSO/REVERSO_FACTURA con id_reversion APLICADA de la misma factura', async () => {
    let sumSql = '';
    const { client } = createLoyaltyMockClient();
    const wrappedClient = {
      async query(sql, params) {
        if (/SUM\(ABS\(fm\.puntos_delta\)\)/.test(String(sql))) sumSql = String(sql);
        return client.query(sql, params);
      }
    };
    await applyLoyaltyReversalForFactura({
      client: wrappedClient, idFactura: 1, idSucursal: 1, idUsuario: 7, tipoReversion: 'PARCIAL',
      idReversion: 45, codigoReversion: 'REV-45', totalFactura: 1000, facturaTotalmenteReversada: false
    });
    assert.match(sumSql, /UPPER\(TRIM\(tm\.codigo\)\) = 'REVERSO'/);
    assert.match(sumSql, /UPPER\(TRIM\(om\.codigo\)\) = 'REVERSO_FACTURA'/);
    assert.match(sumSql, /fr\.id_reversion = fm\.id_reversion/);
    assert.match(sumSql, /fr\.id_factura_original = fm\.id_factura/);
    assert.match(sumSql, /APLICADA/);
  });
});
