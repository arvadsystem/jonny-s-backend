// Guarda estructural del flujo transaccional de createVentaReversion
// (Fase 2), siguiendo el mismo patron ya usado en
// routers/ventas/__tests__/postVentasTransactionRegression.test.mjs para
// el flujo hermano de creacion de ventas: lee el codigo fuente y confirma,
// por regex, que ciertos elementos criticos esten o NO esten presentes.
// Complementa (no reemplaza) las pruebas de comportamiento puro de
// ventasReversionSessionService/EligibilityService/CalculationService.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('services/ventasReversionService.js'), 'utf8');
const routerSource = readFileSync(resolve('routers/ventas.js'), 'utf8');

describe('createVentaReversion — regresion estructural Fase 2', () => {
  it('6) elimina por completo la ventana de 1 hora (declaracion, uso ejecutable y codigo de error)', () => {
    // El identificador puede aparecer en un comentario explicando la
    // eliminacion (ver encabezado del archivo); lo que no debe existir es
    // la DECLARACION/uso ejecutable real.
    assert.doesNotMatch(source, /const REVERSAL_WINDOW_SQL/);
    assert.doesNotMatch(source, /\$\{REVERSAL_WINDOW_SQL\}/);
    assert.doesNotMatch(source, /createReversionError\([^)]*VENTAS_REVERSION_FUERA_VENTANA/);
    assert.doesNotMatch(source, /INTERVAL '1 hour'/);
  });

  it('no reemplaza la ventana por otro limite temporal disfrazado', () => {
    assert.doesNotMatch(source, /INTERVAL '2 hours'/);
    assert.doesNotMatch(source, /INTERVAL '24 hours'/);
    assert.doesNotMatch(source, /fecha_operacion\s*=\s*CURRENT_DATE/);
  });

  it('7) elimina el bloqueo por horario administrativo de sucursal del flujo de creacion (funcion y codigo de error, no solo el comentario que documenta su eliminacion)', () => {
    assert.doesNotMatch(source, /const assertSucursalOpenForReversion/);
    assert.doesNotMatch(source, /await assertSucursalOpenForReversion/);
    assert.doesNotMatch(source, /SUCURSAL_CERRADA_REVERSA_NO_PERMITIDA/);
  });

  it('ya no usa la validacion de sesion legacy assertOriginalCajaSessionOpen (superada por ventasReversionSessionService)', () => {
    assert.doesNotMatch(source, /const assertOriginalCajaSessionOpen/);
    assert.doesNotMatch(source, /await assertOriginalCajaSessionOpen/);
    assert.doesNotMatch(source, /VENTA_SIN_SESION_CAJA_VALIDA/);
  });

  it('resuelve la sesion original desde facturas_cobros, no desde facturas.id_sesion_caja', () => {
    assert.match(source, /resolveOriginalSessionFromCobros/);
    assert.match(source, /lockAndValidateOriginalCajaSession/);
  });

  it('valida elegibilidad de pedido/Cocina y resuelve CANCELADO por codigo', () => {
    assert.match(source, /assertPedidoEligibleForReversion/);
    assert.match(source, /resolveCancelledEstadoPedidoIdOrThrow/);
  });

  it('REGRESION: el INSERT de facturas_reversiones_detalle tiene exactamente 13 placeholders para 13 columnas (bug preexistente corregido en Fase 2: el baseline tenia 14 placeholders para 13 columnas)', () => {
    const match = source.match(/INSERT INTO public\.facturas_reversiones_detalle \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)/);
    assert.ok(match, 'no se encontro el INSERT de facturas_reversiones_detalle');
    const columnCount = match[1].split(',').filter((s) => s.trim()).length;
    const placeholderCount = (match[2].match(/\$\d+/g) || []).length;
    assert.equal(columnCount, 13);
    assert.equal(placeholderCount, 13, `se esperaban 13 placeholders, se encontraron ${placeholderCount}`);
  });

  it('id_caja_actual/id_sesion_caja_actual se persisten con el MISMO valor que original ($4/$5), documentando que Fase 2 elimina el concepto de sesion "actual" distinta', () => {
    assert.match(source, /\$1, \$2, \$3, \$4, \$5, \$4, \$5,/);
  });

  it('20) nunca usa una sesion "actual" distinta a la original al registrar el movimiento de caja', () => {
    const movimientoBlock = source.match(/INSERT INTO public\.cajas_movimientos[\s\S]{0,900}/)?.[0] || '';
    assert.match(movimientoBlock, /sessionContext\.id_sesion_caja/);
    assert.match(movimientoBlock, /sessionContext\.id_caja/);
  });

  it('22) resuelve CANCELADO y PAGO_ANULADO solo cuando la factura queda totalmente reversada, y solo si tiene pedido', () => {
    assert.match(source, /accumulated\.factura_totalmente_reversada && factura\.id_pedido/);
    assert.match(source, /estado_pago = 'PAGO_ANULADO'/);
  });

  it('Fidelizacion e inventario se siguen invocando dentro de la misma transaccion (no se omiten silenciosamente)', () => {
    // Fase 4: revertLoyaltyForFactura fue eliminada por completo (ver
    // applyLoyaltyReversalForFactura en
    // routers/ventas/services/ventasReversionFidelizacionService.js);
    // Fase 3 ya habia eliminado restorePedidoInventoryMovementsForReversion
    // y registerInventoryReturn (ver returnInventoryForReversionLines en
    // routers/ventas/services/ventasReversionInventoryService.js). Se
    // verifica la INVOCACION real de los reemplazos actuales, no solo la
    // presencia de un identificador (que podria ser un comentario
    // explicando por que se elimino algo).
    assert.match(source, /applyLoyaltyReversalForFactura\(/);
    assert.match(source, /returnInventoryForReversionLines\(/);
    assert.doesNotMatch(source, /(const|function)\s+revertLoyaltyForFactura\b/);
    assert.doesNotMatch(source, /revertLoyaltyForFactura\(/);
  });
});

describe('routers/ventas.js — endpoints de reversion Fase 2', () => {
  it('7) Idempotency-Key es obligatorio: existe el validador y el codigo de error especificado', () => {
    assert.match(routerSource, /validateReversionIdempotencyKeyHeader/);
    assert.match(routerSource, /VENTAS_REVERSION_IDEMPOTENCY_KEY_REQUERIDA/);
  });

  it('el validador de Idempotency-Key rechaza arreglos y vacios explicitamente', () => {
    const block = routerSource.match(/const validateReversionIdempotencyKeyHeader[\s\S]{0,600}/)?.[0] || '';
    assert.match(block, /Array\.isArray\(raw\)/);
    assert.match(block, /if \(!value\) return \{ ok: false \}/);
  });

  it('23) expone GET /ventas/:id/reversion-context', () => {
    assert.match(routerSource, /router\.get\('\/ventas\/:id\/reversion-context'/);
  });

  it('24) expone POST /ventas/:id/reversion-preview', () => {
    assert.match(routerSource, /router\.post\('\/ventas\/:id\/reversion-preview'/);
  });
});
