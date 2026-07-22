import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ventasRouterSource = await readFile(new URL('../routers/ventas.js', import.meta.url), 'utf8');
const routeStart = ventasRouterSource.indexOf("router.get('/ventas', checkPermission(['VENTAS_VER'])");
const nextRouteMarker = ventasRouterSource.indexOf("'/ventas/dashboard-resumen'", routeStart);
const routeEnd = ventasRouterSource.lastIndexOf('router.get(', nextRouteMarker);
const listRoute = ventasRouterSource.slice(routeStart, routeEnd);

test('GET /ventas centraliza limites temporales inclusivo/exclusivo', () => {
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.match(listRoute, /resolveVentasTemporalFilter\(req\.query/);
  assert.match(listRoute, /f\.fecha_hora_facturacion >= \$IDX::timestamp/);
  assert.match(listRoute, /f\.fecha_hora_facturacion < \$IDX::timestamp/);
  assert.doesNotMatch(listRoute, /fecha_hora_facturacion\)\)::date/);
  assert.doesNotMatch(listRoute, /VENTAS_LIMIT_72H_CUTOFF_SQL/);
  assert.doesNotMatch(listRoute, /NOW\(\)[\s\S]*INTERVAL '72 hours'/i);
});

test('count, summary y data reutilizan exactamente el mismo whereClause', () => {
  const whereUses = listRoute.match(/\$\{whereClause\}/g) || [];
  assert.equal(whereUses.length, 3);
  assert.match(listRoute, /const \[countResult, summaryResult, result\] = await Promise\.all/);
});

test('respuesta auditable expone rango efectivo y pendientes del mismo resumen', () => {
  assert.match(listRoute, /filters:\s*\{\s*\.\.\.temporalFilter\.filters,/s);
  assert.match(listRoute, /summaryPendientes = includeSummary \? Math\.max\(summaryVentas - summaryCompletadas, 0\)/);
});
