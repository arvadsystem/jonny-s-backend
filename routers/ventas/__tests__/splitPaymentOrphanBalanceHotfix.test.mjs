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

const source = readFileSync(resolve('routers/ventas.js'), 'utf8');

describe('GET /ventas/pedidos-pendientes — Escenario A/C/D: el saldo financiero es la unica fuente de verdad', () => {
  it('el WHERE ya no exige id_factura IS NULL ni una division PENDIENTE existente (causa raiz #2)', () => {
    const fnStart = source.indexOf('async function listarPedidosPendientesPago');
    const fnBody = source.slice(fnStart, fnStart + 6000);
    assert.doesNotMatch(fnBody, /cobrableFacturaScopeSql/, 'la variable/condicion que bloqueaba pedidos con factura parcial debe estar eliminada');
    assert.doesNotMatch(fnBody, /hasPendingSplitDivisionSql/, 'ya no debe exigir una fila PENDIENTE en ventas_cuenta_divisiones para considerar el pedido cobrable');
    assert.match(fnBody, /const filters = \[\s*'UPPER\(TRIM\(ppc\.estado_pago_codigo\)\) = \$1',\s*'COALESCE\(ppc\.monto_pendiente, 0\) > 0'\s*\];/);
  });

  it('Escenario C: COMPLETADO ya NO esta en excludedPedidoEstados (estado operativo no debe bloquear el endpoint financiero)', () => {
    const fnStart = source.indexOf('async function listarPedidosPendientesPago');
    const fnBody = source.slice(fnStart, fnStart + 6000);
    const block = fnBody.match(/const excludedPedidoEstados = \[[\s\S]*?\];/)?.[0] || '';
    assert.ok(block, 'no se encontro el arreglo excludedPedidoEstados');
    assert.doesNotMatch(block, /'COMPLETADO'/);
    // Los estados verdaderamente terminales (venta anulada/cancelada) siguen excluidos.
    assert.match(block, /'CANCELADO'/);
    assert.match(block, /'ANULADO'/);
    assert.match(block, /'PAGO_ANULADO'/);
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
  it('tras persistir las divisiones solicitadas, calcula las lineas sobrantes (no cubiertas por cuentaDivisionPlan) y crea una division PENDIENTE de respaldo', () => {
    const anchor = source.indexOf('const persistedDivisions = await persistCuentaDividida({');
    assert.ok(anchor > -1);
    const block = source.slice(anchor, anchor + 3000);
    assert.match(block, /const assignedLineIndexes = new Set\(/);
    assert.match(block, /const leftoverItems = divisionLines/);
    assert.match(block, /if \(leftoverItems\.length > 0\) \{/);
    assert.match(block, /etiqueta: 'Saldo pendiente de asignar'/);
    assert.match(block, /estadoInicial: 'PENDIENTE'/);
  });

  it('el total de la division de respaldo se calcula 100% desde detalle_pedido (total_linea de cada linea sobrante), nunca desde un total enviado por el frontend', () => {
    const anchor = source.indexOf('const leftoverDivisionPlan = {');
    assert.ok(anchor > -1);
    const block = source.slice(anchor, anchor + 900);
    assert.match(block, /total: roundMoney\(leftoverItems\.reduce\(\(sum, item\) => sum \+ Number\(item\.line\?\.total_linea \|\| 0\), 0\)\)/);
    assert.doesNotMatch(block, /req\.body/);
  });

  it('Escenario F (duplicados): buildCuentaDivisionPlan sigue lanzando CUENTA_DIVIDIDA_ITEM_DUPLICADO cuando una linea se asigna dos veces', () => {
    assert.match(source, /CUENTA_DIVIDIDA_ITEM_DUPLICADO/);
    const fnBlock = source.match(/const buildCuentaDivisionPlan = \([\s\S]{0,3500}/)?.[0] || '';
    assert.match(fnBlock, /if \(assigned\.has\(lineIndex\)\) \{/);
  });

  it('Escenario F: una linea ya facturada (asignada a otra division) no puede volver a facturarse -- detallePedidoRowsDisponibles excluye lineas ya asignadas antes de construir el plan', () => {
    const anchor = source.indexOf('let detallePedidoRowsDisponibles = detallePedidoResult.rows;');
    assert.ok(anchor > -1);
    const block = source.slice(anchor, anchor + 1200);
    assert.match(block, /assignedDetalleIds\.has\(Number\(row\.id_detalle_pedido\)\)/);
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
