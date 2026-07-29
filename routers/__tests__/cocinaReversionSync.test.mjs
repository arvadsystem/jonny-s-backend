// Guarda estructural de la sincronizacion Cocina <-> reversion de venta
// (Fase 3). routers/cocina.js es un router monolitico sin unidades
// exportadas para la consulta GET /cocina/pedidos ni para el handler PUT
// /cocina/pedidos/:id/estado; siguiendo el mismo patron ya usado en
// services/__tests__/ventasReversionService.transactionRegression.test.mjs
// para el flujo hermano de reversion, esta prueba lee el codigo fuente y
// confirma por regex la presencia/forma de los cambios criticos. No
// reemplaza una prueba de integracion contra Postgres real (no disponible
// en este entorno).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('routers/cocina.js'), 'utf8');

describe('routers/cocina.js — sincronizacion con reversion de venta (Fase 3)', () => {
  it('9) el alias local de estados_pedido ahora reconoce PENDIENTE y CANCELADO (antes solo por omision accidental)', () => {
    const block = source.match(/const ESTADO_PEDIDO_CODES = \{[\s\S]*?\n\};/)?.[0] || '';
    assert.match(block, /PENDIENTE:/);
    assert.match(block, /CANCELADO: new Set\(\['cancelado', 'cancelada', 'anulado', 'anulada'\]\)/);
  });

  it('22-24) bloqueo explicito de pedidos CANCELADO en la transicion de Cocina', () => {
    assert.match(source, /estadoActual === 'CANCELADO'/);
    assert.match(source, /COCINA_PEDIDO_CANCELADO_NO_OPERABLE/);
  });

  it('11) la actualizacion final de estado es condicional (compare-and-swap) contra el estado leido bajo lock', () => {
    const updateBlock = source.match(/UPDATE pedidos[\s\S]{0,600}/)?.[0] || '';
    assert.match(updateBlock, /AND id_estado_pedido = \$3/);
    assert.match(source, /idEstadoDestino, idPedido, Number\(pedido\.id_estado_pedido\)/);
  });

  it('una actualizacion que no afecte filas (rowCount 0) devuelve conflicto controlado, no exito silencioso', () => {
    assert.match(source, /updatedPedidoResult\.rowCount === 0/);
    assert.match(source, /COCINA_TRANSICION_CONFLICTO/);
  });

  it('9-10) la consulta GET /cocina/pedidos calcula cantidad_revertida_acumulada via detalle_facturas_origen.id_detalle_pedido, no por producto/receta/nombre', () => {
    const joinBlock = source.match(/LEFT JOIN LATERAL \(\s*SELECT COALESCE\(SUM\(frd\.cantidad_revertida\)[\s\S]{0,600}/)?.[0] || '';
    assert.match(joinBlock, /detalle_facturas_origen dfo_kds/);
    assert.match(joinBlock, /dfo_kds\.id_detalle_pedido = dp\.id_detalle_pedido/);
    assert.match(joinBlock, /UPPER\(TRIM\(COALESCE\(fr_kds\.estado, ''\)\)\) = 'APLICADA'/);
  });

  it('12) las lineas completamente reversadas se excluyen (nunca se filtra solo en frontend) usando continue, no return (bug corregido)', () => {
    const block = source.match(/const cantidadEfectiva = cantidad - cantidadRevertidaAcumulada;[\s\S]{0,80}/)?.[0] || '';
    assert.match(block, /if \(cantidadEfectiva <= 0\) \{\s*continue;/);
    assert.doesNotMatch(block, /if \(cantidadEfectiva <= 0\) \{\s*return;/);
  });

  it('detalle_pedidos.cantidad nunca se modifica destructivamente: cantidad_efectiva es solo de lectura/respuesta', () => {
    assert.doesNotMatch(source, /UPDATE (public\.)?detalle_pedido\s+SET\s+cantidad\s*=/);
  });
});
