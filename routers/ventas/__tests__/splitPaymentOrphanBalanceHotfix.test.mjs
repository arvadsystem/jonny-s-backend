// HOTFIX: cuenta dividida con saldo pendiente oculto.
//
// routers/ventas.js es un router monolitico sin funciones exportadas para
// listarPedidosPendientesPago ni para el handler de
// POST /ventas/pedidos/:id/registrar-pago (mismo patron ya usado en
// routers/ventas/__tests__/postVentasTransactionRegression.test.mjs para
// el flujo hermano de creacion de ventas): esta prueba lee el codigo
// fuente y confirma, por regex, que los elementos criticos del hotfix
// esten (o NO esten) presentes. No reemplaza pruebas de integracion
// contra Postgres real (no disponible en este entorno) -- ver el reporte
// de entrega para el detalle de pruebas de escritorio manuales.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS } from '../services/cuentaDivididaSplitService.js';

const source = readFileSync(resolve('routers/ventas.js'), 'utf8');

describe('GET /ventas/pedidos-pendientes — Escenario A/C/D: el saldo financiero es la unica fuente de verdad', () => {
  it('el WHERE ya no exige id_factura IS NULL ni una division PENDIENTE existente (causa raiz #2)', () => {
    const fnStart = source.indexOf('async function listarPedidosPendientesPago');
    const fnBody = source.slice(fnStart, fnStart + 6000);
    assert.doesNotMatch(fnBody, /cobrableFacturaScopeSql/, 'la variable/condicion que bloqueaba pedidos con factura parcial debe estar eliminada');
    assert.doesNotMatch(fnBody, /hasPendingSplitDivisionSql/, 'ya no debe exigir una fila PENDIENTE en ventas_cuenta_divisiones para considerar el pedido cobrable');
    assert.match(fnBody, /const filters = \[\s*'UPPER\(TRIM\(ppc\.estado_pago_codigo\)\) = \$1',\s*'COALESCE\(ppc\.monto_pendiente, 0\) > 0'\s*\];/);
  });

  it('el listado usa el arreglo compartido EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS (nunca uno literal duplicado)', () => {
    const fnStart = source.indexOf('async function listarPedidosPendientesPago');
    const fnBody = source.slice(fnStart, fnStart + 6000);
    assert.match(fnBody, /const excludedPedidoEstados = \[\.\.\.EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS\];/);
  });

  it('Escenario C / #7 NO_ENTREGADO: ni COMPLETADO ni NO_ENTREGADO estan en la lista de exclusion real (prueba ejecutable, no regex)', () => {
    assert.ok(!EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('COMPLETADO'));
    assert.ok(!EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('NO_ENTREGADO'));
    // Los estados verdaderamente terminales (venta anulada/cancelada) siguen excluidos.
    assert.ok(EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('CANCELADO'));
    assert.ok(EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('ANULADO'));
    assert.ok(EXCLUDED_PEDIDOS_PENDIENTES_ESTADOS.includes('PAGO_ANULADO'));
  });

  it('Escenario D: puede_cobrar (listado) depende unicamente de estado_pago + monto_pendiente, nunca de id_factura', () => {
    const fnStart = source.indexOf('async function listarPedidosPendientesPago');
    const fnBody = source.slice(fnStart, fnStart + 20000);
    const block = fnBody.match(/\(\s*UPPER\(TRIM\(ppc\.estado_pago_codigo\)\) = \$1\s*AND COALESCE\(ppc\.monto_pendiente, 0\) > 0\s*\) AS puede_cobrar,/)?.[0];
    assert.ok(block, 'no se encontro la expresion simplificada de puede_cobrar en el listado');
  });

  it('la respuesta incluye items/items_asignados/items_sin_asignar', () => {
    const fnStart = source.indexOf('async function listarPedidosPendientesPago');
    const fnBody = source.slice(fnStart, fnStart + 20000);
    assert.match(fnBody, /items_total/);
    assert.match(fnBody, /items_asignados/);
    assert.match(fnBody, /items_sin_asignar: Math\.max\(Number\(row\.items_total \|\| 0\) - Number\(row\.items_asignados \|\| 0\), 0\)/);
  });
});

describe('GET /ventas/:id — puede_cobrar (detalle) usa la misma regla simplificada', () => {
  it('ya no depende de f.id_factura IS NULL ni de divisiones_pendientes_count', () => {
    const block = source.match(/\(\s*UPPER\(TRIM\(COALESCE\(ppc\.estado_pago_codigo, ''\)\)\) = '\$\{PEDIDO_PENDIENTE_ESTADO_PAGO\}'\s*AND COALESCE\(ppc\.monto_pendiente, 0\) > 0\s*\) AS puede_cobrar,/)?.[0];
    assert.ok(block, 'no se encontro la expresion simplificada de puede_cobrar en GET /ventas/:id');
    assert.doesNotMatch(block, /divisiones_pendientes_count/);
    assert.doesNotMatch(block, /f\.id_factura IS NULL/);
  });
});

describe('POST /ventas/pedidos/:id/registrar-pago — Escenario A/F: division de respaldo para lineas sin asignar', () => {
  it('tras persistir las divisiones solicitadas, calcula las lineas sobrantes (no cubiertas por cuentaDivisionPlan) y crea UNA division PENDIENTE de respaldo POR LINEA via buildBackupDivisionsPlan (alternativa recomendada, ronda 2)', () => {
    const anchor = source.indexOf('const persistedDivisions = await persistCuentaDividida({');
    assert.ok(anchor > -1);
    const block = source.slice(anchor, anchor + 3200);
    assert.match(block, /const assignedLineIndexes = new Set\(/);
    assert.match(block, /const leftoverItems = divisionLines/);
    assert.match(block, /if \(leftoverItems\.length > 0\) \{/);
    assert.match(block, /const backupDivisions = buildBackupDivisionsPlan\(\{/);
    assert.match(block, /estadoInicial: 'PENDIENTE'/);
    // Nunca debe volver a existir una sola division agregada "de asignar"
    // que despues impida separar las lineas en personas distintas.
    assert.doesNotMatch(block, /etiqueta: 'Saldo pendiente de asignar'/);
  });

  it('el total de cada division de respaldo se calcula 100% desde detalle_pedido (buildBackupDivisionsPlan usa item.line.total_linea), nunca desde un total enviado por el frontend', () => {
    const serviceSource = readFileSync(resolve('routers/ventas/services/cuentaDivididaSplitService.js'), 'utf8');
    const fnBlock = serviceSource.match(/export const buildBackupDivisionsPlan = \([\s\S]{0,900}/)?.[0] || '';
    assert.match(fnBlock, /total: roundMoney\(item\?\.line\?\.total_linea \|\| 0\)/);
    assert.doesNotMatch(fnBlock, /req\.body/);
  });

  it('correccion #1: el orden de las divisiones nuevas se recalcula con resolveNextOrdenSequence (nunca se confia en division.orden enviado por el frontend)', () => {
    const registrarPagoStart = source.indexOf("router.post('/ventas/pedidos/:id/registrar-pago'");
    assert.ok(registrarPagoStart > -1);
    const anchor = source.indexOf('const cuentaDivisionPlan = buildCuentaDivisionPlan({', registrarPagoStart);
    assert.ok(anchor > -1, 'no se encontro la construccion del plan dentro de registrar-pago');
    const block = source.slice(anchor, anchor + 1200);
    assert.match(block, /const nuevosOrdenes = resolveNextOrdenSequence\(\{/);
    assert.match(block, /division\.orden = nuevosOrdenes\[index\];/);
  });

  it('correccion #1: la division a cobrar se selecciona por POSICION (selectNewDivisionToCharge), nunca comparando contra el valor de orden persistido', () => {
    assert.match(source, /cuentaDivisionPago = selectNewDivisionToCharge\(\{/);
    assert.doesNotMatch(source, /persistedDivisions\.find\(\(division\) => Number\(division\.orden\) === Number\(cobrarDivisionOrdenRequested\)\)/);
  });

  it('correccion #5: una division de respaldo automatica ya superada por el nuevo plan se anula (nunca queda representando lineas duplicadas)', () => {
    assert.match(source, /const supersededBackupDivisionIds = resolveSupersededBackupDivisionIds\(\{/);
    assert.match(source, /SET estado = 'ANULADA'/);
  });

  it('Escenario F (duplicados): buildCuentaDivisionPlan sigue lanzando CUENTA_DIVIDIDA_ITEM_DUPLICADO cuando una linea se asigna dos veces', () => {
    assert.match(source, /CUENTA_DIVIDIDA_ITEM_DUPLICADO/);
    const fnBlock = source.match(/const buildCuentaDivisionPlan = \([\s\S]{0,3500}/)?.[0] || '';
    assert.match(fnBlock, /if \(assigned\.has\(lineIndex\)\) \{/);
  });

  it('Escenario F: una linea ya facturada (asignada a otra division) no puede volver a facturarse -- detallePedidoRowsDisponibles usa filterAvailableLines (ANULADA/redistribuible-aware) antes de construir el plan', () => {
    const anchor = source.indexOf('const detallePedidoRowsDisponibles = filterAvailableLines({');
    assert.ok(anchor > -1);
    const block = source.slice(anchor, anchor + 300);
    assert.match(block, /allLines: detallePedidoResult\.rows,/);
    assert.match(block, /divisions: divisionesExistentesConItems/);
  });

  it('una division pagada no puede cobrarse otra vez (CUENTA_DIVISION_YA_FACTURADA)', () => {
    assert.match(source, /CUENTA_DIVISION_YA_FACTURADA/);
  });

  it('el total cobrado se recalcula en backend contra el detalle de factura insertado y rechaza descuadres (PEDIDO_FACTURA_NO_CUADRA)', () => {
    assert.match(source, /PEDIDO_FACTURA_NO_CUADRA/);
    const anchor = source.indexOf('PEDIDO_FACTURA_NO_CUADRA');
    const contextBefore = source.slice(Math.max(0, anchor - 800), anchor);
    assert.match(contextBefore, /totalFacturadoCalculado/);
  });

  it('Escenario G (venta normal, sin cuenta dividida): el saldo pendiente sin asignar solo se calcula cuando cuentaDivisionPago existe (no afecta el pago completo tradicional)', () => {
    const anchor = source.indexOf('const montoPendienteSinAsignar = Math.max(roundMoney(totalPedido - totalDividido), 0);');
    assert.ok(anchor > -1);
    const contextBefore = source.slice(Math.max(0, anchor - 1200), anchor);
    assert.match(contextBefore, /if \(cuentaDivisionPago\) \{/);
  });

  it('transaccion unica con BEGIN/COMMIT/ROLLBACK envolviendo todo el registro de pago', () => {
    const fnStart = source.indexOf("router.post('/ventas/pedidos/:id/registrar-pago'");
    assert.ok(fnStart > -1);
    const fnBody = source.slice(fnStart, fnStart + 40000);
    assert.match(fnBody, /await client\.query\('COMMIT'\)/);
    assert.match(fnBody, /await client\.query\('ROLLBACK'\)/);
  });
});
