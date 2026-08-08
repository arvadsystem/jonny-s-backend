import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatAuditQty,
  buildInventoryMovementDescription,
  buildLineMovementRows,
  registrarMovimientosPedido
} from '../inventarioMovimientoService.js';

// Incidente confirmado en produccion (sucursal El Carmen, id_usuario=45,
// id_sesion_caja=50): POST /ventas/pedidos-pendientes fallaba con Postgres 22001
// ("value too long for type character varying(150)") sobre
// public.movimientos_inventario.descripcion. Causa raiz: buildLineMovementRows
// interpolaba shortage.requerido/disponible/faltante (numeros derivados de resta en
// JS, ej. 0.30000000000000004) directo en un template literal sin normalizar,
// pudiendo superar 150 caracteres. Este archivo prueba, con ejecucion real (no solo
// inspeccion de codigo), que:
//   1. formatAuditQty elimina el ruido IEEE-754 sin tocar la cantidad real.
//   2. buildInventoryMovementDescription nunca excede 150 caracteres, en ningun
//      escenario soportado, incluyendo IDs/numeros extremos.
//   3. El INSERT real (via registrarMovimientosPedido -> insertMovimientosBatch)
//      nunca recibe una descripcion > 150 caracteres.
//   4. La cantidad real del movimiento (columna `cantidad`) nunca se redondea por
//      este fix -- solo se normaliza la REPRESENTACION TEXTUAL de auditoria.

describe('formatAuditQty: elimina ruido IEEE-754 sin notacion cientifica', () => {
  it('0.30000000000000004 -> "0.3"', () => {
    assert.equal(formatAuditQty(0.30000000000000004), '0.3');
  });

  it('0.047600000000000004 -> "0.0476"', () => {
    assert.equal(formatAuditQty(0.047600000000000004), '0.0476');
  });

  it('0.0011000000000000001 -> "0.0011"', () => {
    assert.equal(formatAuditQty(0.0011000000000000001), '0.0011');
  });

  it('12 -> "12" (entero sin decimales de relleno)', () => {
    assert.equal(formatAuditQty(12), '12');
  });

  it('valores no finitos se degradan a "0" sin lanzar', () => {
    assert.equal(formatAuditQty(NaN), '0');
    assert.equal(formatAuditQty(Infinity), '0');
    assert.equal(formatAuditQty(undefined), '0');
    assert.equal(formatAuditQty(null), '0');
  });

  it('-0 se normaliza a "0", no "-0"', () => {
    assert.equal(formatAuditQty(-0), '0');
  });
});

describe('buildInventoryMovementDescription: garantiza <=150 y conserva trazabilidad', () => {
  it('PRUEBA 1: insumo con shortage 0.30000000000000004 -> <=150, sin ruido IEEE-754, contiene "0.3"', () => {
    const descripcion = buildInventoryMovementDescription({
      pedidoId: 3986,
      tipoRecurso: 'insumo',
      resourceId: 162,
      detalleId: 6820,
      origenConsumo: 'RECETA',
      actorUserId: 45,
      shortage: { requerido: 0.30000000000000004, disponible: 0, faltante: 0.30000000000000004 }
    });
    assert.ok(descripcion.length <= 150, `longitud ${descripcion.length}`);
    assert.doesNotMatch(descripcion, /0\.30000000000000004/);
    assert.match(descripcion, /0\.3\b/);
    // Trazabilidad minima conservada.
    assert.match(descripcion, /3986/);
    assert.match(descripcion, /162/);
    assert.match(descripcion, /6820/);
    assert.match(descripcion, /RECETA/);
    assert.match(descripcion, /45/);
  });

  it('PRUEBA 2: insumo con shortage 0.047600000000000004 -> contiene "0.0476", <=150', () => {
    const descripcion = buildInventoryMovementDescription({
      pedidoId: 3986,
      tipoRecurso: 'insumo',
      resourceId: 162,
      detalleId: 6820,
      origenConsumo: 'RECETA',
      actorUserId: 45,
      shortage: { requerido: 0.047600000000000004, disponible: 0, faltante: 0.047600000000000004 }
    });
    assert.ok(descripcion.length <= 150);
    assert.match(descripcion, /0\.0476\b/);
    assert.doesNotMatch(descripcion, /0\.047600000000000004/);
  });

  it('PRUEBA 3: producto sin shortage -> descripcion valida, <=150', () => {
    const descripcion = buildInventoryMovementDescription({
      pedidoId: 3986,
      tipoRecurso: 'producto',
      resourceId: 280,
      detalleId: 6819,
      origenConsumo: 'PRODUCTO',
      actorUserId: 45,
      shortage: null
    });
    assert.ok(descripcion.length <= 150);
    assert.match(descripcion, /3986/);
    assert.match(descripcion, /280/);
    assert.match(descripcion, /6819/);
  });

  it('PRUEBA 4: insumo sin shortage, origen RECETA -> descripcion valida, <=150', () => {
    const descripcion = buildInventoryMovementDescription({
      pedidoId: 3986,
      tipoRecurso: 'insumo',
      resourceId: 247,
      detalleId: 6820,
      origenConsumo: 'RECETA',
      actorUserId: 45,
      shortage: null
    });
    assert.ok(descripcion.length <= 150);
    assert.match(descripcion, /RECETA/);
  });

  it('PRUEBA 5: insumo con origen EXTRA -> descripcion valida, <=150', () => {
    const descripcion = buildInventoryMovementDescription({
      pedidoId: 3986,
      tipoRecurso: 'insumo',
      resourceId: 247,
      detalleId: 6820,
      origenConsumo: 'EXTRA',
      actorUserId: 45,
      shortage: null
    });
    assert.ok(descripcion.length <= 150);
    assert.match(descripcion, /EXTRA/);
  });

  it('PRUEBA 6: insumo con origen SALSA -> descripcion valida, <=150', () => {
    const descripcion = buildInventoryMovementDescription({
      pedidoId: 3986,
      tipoRecurso: 'insumo',
      resourceId: 247,
      detalleId: 6820,
      origenConsumo: 'SALSA',
      actorUserId: 45,
      shortage: null
    });
    assert.ok(descripcion.length <= 150);
    assert.match(descripcion, /SALSA/);
  });

  it('PRUEBA 7: IDs y cantidades extremas -> <=150 sin perder los identificadores esenciales', () => {
    const descripcion = buildInventoryMovementDescription({
      pedidoId: 2147483647,
      tipoRecurso: 'insumo',
      resourceId: 2147483647,
      detalleId: 2147483647,
      origenConsumo: 'RECETA',
      actorUserId: 2147483647,
      shortage: {
        requerido: 123456789.123456,
        disponible: -123456789.123456,
        faltante: 123456789.123456
      }
    });
    assert.ok(descripcion.length <= 150, `longitud ${descripcion.length}: ${descripcion}`);
    // Los identificadores esenciales (pedido, insumo, detalle) deben sobrevivir
    // incluso en el escenario mas extremo.
    assert.match(descripcion, /2147483647/);
  });

  it('nunca produce una descripcion > 150 sobre un muestreo amplio de combinaciones', () => {
    const origenes = ['RECETA', 'EXTRA', 'SALSA'];
    const shortageVariants = [
      null,
      { requerido: 0.1 + 0.2, disponible: 0, faltante: 0.1 + 0.2 },
      { requerido: 999999999.999999, disponible: -999999999.999999, faltante: 999999999.999999 }
    ];
    for (const origen of origenes) {
      for (const shortage of shortageVariants) {
        for (const idMagnitude of [1, 999, 2147483647]) {
          const descripcion = buildInventoryMovementDescription({
            pedidoId: idMagnitude,
            tipoRecurso: 'insumo',
            resourceId: idMagnitude,
            detalleId: idMagnitude,
            origenConsumo: origen,
            actorUserId: idMagnitude,
            shortage
          });
          assert.ok(
            descripcion.length <= 150,
            `origen=${origen} shortage=${JSON.stringify(shortage)} id=${idMagnitude} -> len=${descripcion.length}: ${descripcion}`
          );
        }
      }
    }
  });
});

describe('buildLineMovementRows: usa el formato compacto y no altera cantidad', () => {
  it('la fila generada trae descripcion <=150 y cantidad exacta sin redondear', () => {
    const productosById = new Map();
    const insumosById = new Map([[162, { id_insumo: 162, id_almacen: 9 }]]);
    const rows = buildLineMovementRows({
      idPedido: 3986,
      actorUserId: 45,
      productosById,
      insumosById,
      movementRows: [
        {
          tipo_recurso: 'insumo',
          id_insumo: 162,
          id_detalle_pedido: 6820,
          origen_consumo: 'RECETA',
          cantidad: 0.30000000000000004
        }
      ],
      shortagesByResource: new Map([
        ['insumo:162', { requerido: 0.30000000000000004, disponible: 0, faltante: 0.30000000000000004 }]
      ])
    });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].descripcion.length <= 150);
    // PRUEBA 9: la cantidad real del movimiento no se redondea por este fix.
    assert.equal(rows[0].cantidad, 0.30000000000000004);
  });
});

describe('registrarMovimientosPedido -> insertMovimientosBatch (integracion real con mock de client.query)', () => {
  const buildMockClient = () => {
    const calls = [];
    return {
      calls,
      client: {
        query: async (sql, params) => {
          calls.push({ sql: String(sql), params });
          return { rows: [], rowCount: 0 };
        }
      }
    };
  };

  it('PRUEBA 8: ningun valor de descripcion enviado al INSERT supera 150 caracteres', async () => {
    const { client, calls } = buildMockClient();
    const productosById = new Map();
    const insumosById = new Map([
      [162, { id_insumo: 162, id_almacen: 9 }],
      [247, { id_insumo: 247, id_almacen: 9 }]
    ]);
    const insumoQtyMap = new Map([[162, 1], [247, 1]]);
    const productoQtyMap = new Map();

    await registrarMovimientosPedido({
      client,
      idPedido: 3986,
      actorUserId: 45,
      productoQtyMap,
      insumoQtyMap,
      productosById,
      insumosById,
      movementRows: [
        {
          tipo_recurso: 'insumo',
          id_insumo: 162,
          id_detalle_pedido: 6820,
          origen_consumo: 'RECETA',
          cantidad: 0.30000000000000004
        },
        {
          tipo_recurso: 'insumo',
          id_insumo: 247,
          id_detalle_pedido: 6821,
          origen_consumo: 'EXTRA',
          cantidad: 2
        }
      ],
      shortagesByResource: new Map([
        ['insumo:162', { requerido: 0.30000000000000004, disponible: 0, faltante: 0.30000000000000004 }]
      ])
    });

    const insertCall = calls.find((call) => /INSERT INTO public\.movimientos_inventario/.test(call.sql));
    assert.ok(insertCall, 'debe haberse ejecutado el INSERT de movimientos_inventario');
    // 10 parametros por fila (ver insertMovimientosBatch); descripcion es el ultimo.
    assert.equal(insertCall.params.length % 10, 0);
    const rowCount = insertCall.params.length / 10;
    assert.equal(rowCount, 2);
    for (let i = 0; i < rowCount; i += 1) {
      const descripcion = insertCall.params[i * 10 + 9];
      assert.ok(typeof descripcion === 'string' || descripcion === null);
      if (descripcion) {
        assert.ok(descripcion.length <= 150, `fila ${i}: longitud ${descripcion.length}`);
      }
    }
  });

  it('PRUEBA 9: la cantidad enviada al INSERT es el valor real, no una version redondeada para auditoria', async () => {
    const { client, calls } = buildMockClient();
    const insumosById = new Map([[162, { id_insumo: 162, id_almacen: 9 }]]);
    const insumoQtyMap = new Map([[162, 1]]);

    await registrarMovimientosPedido({
      client,
      idPedido: 3986,
      actorUserId: 45,
      productoQtyMap: new Map(),
      insumoQtyMap,
      productosById: new Map(),
      insumosById,
      movementRows: [
        {
          tipo_recurso: 'insumo',
          id_insumo: 162,
          id_detalle_pedido: 6820,
          origen_consumo: 'RECETA',
          cantidad: 0.30000000000000004
        }
      ],
      shortagesByResource: new Map([
        ['insumo:162', { requerido: 0.30000000000000004, disponible: 0, faltante: 0.30000000000000004 }]
      ])
    });

    const insertCall = calls.find((call) => /INSERT INTO public\.movimientos_inventario/.test(call.sql));
    const cantidadEnviada = insertCall.params[0];
    assert.equal(cantidadEnviada, 0.30000000000000004, 'la cantidad real no debe redondearse por este fix');
  });

  it('PRUEBA 10: un shortage que antes producia >150 caracteres ya no revienta el flujo (sin 22001, movimientos generados)', async () => {
    // Reproduce el formato ANTERIOR al fix para demostrar que si generaba >150.
    const legacyDescripcion = `Descuento por pedido #3986 (insumo 162, detalle 6820, origen RECETA) - faltante auditado req:${0.30000000000000004} disp:${0} deficit:${0.30000000000000004} - usuario 45`;
    assert.ok(legacyDescripcion.length > 150, 'el formato anterior debia superar 150 (reproduce el bug reportado)');

    const { client, calls } = buildMockClient();
    const insumosById = new Map([[162, { id_insumo: 162, id_almacen: 9 }]]);
    const insumoQtyMap = new Map([[162, 1]]);

    const insertedCount = await registrarMovimientosPedido({
      client,
      idPedido: 3986,
      actorUserId: 45,
      productoQtyMap: new Map(),
      insumoQtyMap,
      productosById: new Map(),
      insumosById,
      movementRows: [
        {
          tipo_recurso: 'insumo',
          id_insumo: 162,
          id_detalle_pedido: 6820,
          origen_consumo: 'RECETA',
          cantidad: 0.30000000000000004
        }
      ],
      shortagesByResource: new Map([
        ['insumo:162', { requerido: 0.30000000000000004, disponible: 0, faltante: 0.30000000000000004 }]
      ])
    });

    assert.equal(insertedCount, 1, 'el movimiento debe generarse -- no se omite inventario ni trazabilidad');
    const insertCall = calls.find((call) => /INSERT INTO public\.movimientos_inventario/.test(call.sql));
    assert.ok(insertCall);
    const descripcionGenerada = insertCall.params[9];
    assert.ok(descripcionGenerada.length <= 150);
    assert.doesNotMatch(descripcionGenerada, /0\.30000000000000004/);
  });
});
