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
const gateSource = readFileSync(resolve('routers/ventas/services/ventasReversionIdempotencyGateService.js'), 'utf8');

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
    assert.match(source, /resolvePedidoReversionContext/);
    assert.match(source, /resolveCancelledEstadoPedidoIdOrThrow/);
  });

  it('REGRESION: el INSERT de facturas_reversiones_detalle conserva 16 placeholders para 16 columnas', () => {
    const match = source.match(/INSERT INTO public\.facturas_reversiones_detalle \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)/);
    assert.ok(match, 'no se encontro el INSERT de facturas_reversiones_detalle');
    const columnCount = match[1].split(',').filter((s) => s.trim()).length;
    const placeholderCount = (match[2].match(/\$\d+/g) || []).length;
    assert.equal(columnCount, 16);
    assert.equal(placeholderCount, 16, `se esperaban 16 placeholders, se encontraron ${placeholderCount}`);
  });

  it('id_caja_actual/id_sesion_caja_actual se persisten con el MISMO valor que original ($4/$5), documentando que Fase 2 elimina el concepto de sesion "actual" distinta', () => {
    assert.match(source, /\$1, \$2, \$3, \$4, \$5, \$4, \$5,/);
  });

  it('20) nunca usa una sesion "actual" distinta a la original al registrar el movimiento de caja', () => {
    const movimientoBlock = source.match(/INSERT INTO public\.cajas_movimientos[\s\S]{0,900}/)?.[0] || '';
    assert.match(movimientoBlock, /sessionContext\.id_sesion_caja/);
    assert.match(movimientoBlock, /sessionContext\.id_caja/);
  });

  it('Caja solo registra la porcion efectiva y omite el INSERT para tarjeta/transferencia', () => {
    assert.match(source, /if \(paymentAllocation\.monto_efectivo_reversado > 0\)/);
    assert.match(source, /paymentAllocation\.monto_efectivo_reversado/);
    assert.doesNotMatch(source, /idTipoMovimientoCaja,[\s\S]{0,80}\buserId,[\s\S]{0,80}\bmontoReversado,/);
  });

  it('resuelve factura/cobros/scope antes de idempotencia y valida sesion solo despues de descartar replay/conflicto', () => {
    const createStart = source.indexOf('export const createVentaReversion');
    const cobrosIndex = source.indexOf('resolveOriginalSessionFromCobros({', createStart);
    const gateIndex = source.indexOf('resolveReversionIdempotencyGate({', cobrosIndex);
    const detailsIndex = source.indexOf('resolveFacturaLinesForUpdate(client, facturaId)', gateIndex);
    assert.ok(cobrosIndex >= 0 && cobrosIndex < gateIndex && gateIndex < detailsIndex);
    assert.match(source.slice(gateIndex, detailsIndex), /idFactura: facturaId[\s\S]*idSucursal[\s\S]*idSesionCaja: resolvedSession\.id_sesion_caja/);

    const reserveIndex = gateSource.indexOf('idempotency.reserve(client, {');
    const terminalIndex = gateSource.indexOf('reservation?.replay || reservation?.conflict', reserveIndex);
    const validateIndex = gateSource.indexOf('validateSession({', terminalIndex);
    assert.ok(reserveIndex >= 0 && reserveIndex < terminalIndex && terminalIndex < validateIndex);
  });

  it('replay retorna antes de detalles, cabecera, Caja, inventario, fidelizacion e impresion', () => {
    const replayIndex = source.indexOf('if (idempotencyGate.terminal)');
    for (const marker of [
      'resolveFacturaLinesForUpdate(client, facturaId)',
      'INSERT INTO public.facturas_reversiones (',
      'INSERT INTO public.cajas_movimientos (',
      'returnInventoryForReversionLines({',
      'applyLoyaltyReversalForFactura({',
      'enqueueAutomaticVentaReversionPrintJob({'
    ]) {
      assert.ok(replayIndex >= 0 && replayIndex < source.indexOf(marker), `replay debe anteceder ${marker}`);
    }
  });

  it('un fallo intermedio conserva ROLLBACK y el exito idempotente ocurre antes de COMMIT', () => {
    const rollbackIndex = source.indexOf("client.query('ROLLBACK')");
    const saveIndex = source.indexOf('idempotency.saveSuccess');
    const commitIndex = source.indexOf("client.query('COMMIT')", saveIndex);
    assert.ok(rollbackIndex >= 0);
    assert.ok(saveIndex >= 0 && saveIndex < commitIndex);
  });

  it('una reserva nueva y la validacion de sesion comparten la transaccion; sesion cerrada cae al ROLLBACK', () => {
    const beginIndex = source.indexOf("client.query('BEGIN')");
    const gateIndex = source.indexOf('resolveReversionIdempotencyGate({', beginIndex);
    const rollbackIndex = source.indexOf("client.query('ROLLBACK')", gateIndex);
    assert.ok(beginIndex >= 0 && beginIndex < gateIndex && gateIndex < rollbackIndex);
    assert.match(source.slice(gateIndex, gateIndex + 500), /validateSession: lockAndValidateOriginalCajaSession/);
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

  it('la reserva y el SUCCESS vinculan usuario, sucursal, sesion original y factura', () => {
    const routeStart = routerSource.indexOf('const creation = await createVentaReversion({');
    const route = routerSource.slice(routeStart, routeStart + 2400);
    assert.match(route, /idUsuario,[\s\S]*idSucursal: scope\?\.idSucursal,[\s\S]*idSesionCaja: scope\?\.idSesionCaja,[\s\S]*idFactura: scope\?\.idFactura/);
    assert.match(route, /idFactura,[\s\S]*idUsuario,[\s\S]*idSucursal: result\?\.id_sucursal,[\s\S]*idSesionCaja: result\?\.id_sesion_caja_original/);
  });
});
