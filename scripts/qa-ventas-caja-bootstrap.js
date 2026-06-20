import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildCajaBootstrapCacheKey,
  clearVentasCajaBootstrapCache,
  fetchCachedCajaBootstrap
} from '../routers/ventas/services/cajaBootstrapCacheService.js';

process.env.VENTAS_CATALOG_CACHE_TTL_MS = '5000';

const handlersSource = readFileSync(new URL('../routers/ventas/handlers/catalogosHandlers.js', import.meta.url), 'utf8');
const routerSource = readFileSync(new URL('../routers/ventas.js', import.meta.url), 'utf8');
const ventasModuleSources = [
  routerSource,
  handlersSource,
  readFileSync(new URL('../routers/ventas/services/complementosCatalogService.js', import.meta.url), 'utf8')
].join('\n');

assert.match(routerSource, /router\.get\('\/ventas\/caja\/bootstrap'/, 'debe existir el bootstrap de Caja');
assert.match(handlersSource, /r\.id_tipo_departamento\s*=\s*\$\$\{params\.length\}/, 'el departamento debe formar parte del SQL parametrizado');
assert.match(handlersSource, /mv\.id_sucursal\s*=\s*\$1/, 'las recetas deben filtrarse por sucursal en SQL');
assert.match(handlersSource, /if \(!search[^]*return res\.status\(200\)\.json\(\[\]\)/, 'clientes sin busqueda valida deben devolver vacio');
assert.match(handlersSource, /Math\.min\(50,/, 'clientes debe limitarse a un maximo de 50');
assert.doesNotMatch(ventasModuleSources, /new\s+(?:Pool|Client)\s*\(/, 'Ventas no debe crear Pool ni Client');

const connectCount = (routerSource.match(/pool\.connect\(\)/g) || []).length;
const releaseCount = (routerSource.match(/client\.release\(\)/g) || []).length;
assert.ok(connectCount > 0, 'la QA debe encontrar transacciones reales');
assert.ok(releaseCount >= connectCount, 'todo cliente adquirido en Ventas debe tener liberacion');

clearVentasCajaBootstrapCache();
let sharedLoads = 0;
const keySucursal1 = buildCajaBootstrapCacheKey({ idSucursal: 1, idTipoDepartamento: 10 });
const loader = async () => {
  sharedLoads += 1;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return {
    data: {
      id_sucursal: 1,
      departamentos: [{ id_tipo_departamento: 10 }],
      departamento_activo: { id_tipo_departamento: 10 },
      recetas: [{ id_receta: 1, id_tipo_departamento: 10 }]
    },
    metrics: { sql_duration_ms: 3, mapping_duration_ms: 1 }
  };
};
const concurrent = await Promise.all([
  fetchCachedCajaBootstrap(keySucursal1, loader),
  fetchCachedCajaBootstrap(keySucursal1, loader),
  fetchCachedCajaBootstrap(keySucursal1, loader)
]);
assert.equal(sharedLoads, 1, 'solicitudes simultaneas iguales deben compartir una sola carga');
assert.deepEqual(concurrent.map((entry) => entry.cache).sort(), ['HIT', 'HIT', 'MISS']);

concurrent[0].value.data.recetas[0].id_receta = 999;
const cachedAgain = await fetchCachedCajaBootstrap(keySucursal1, loader);
assert.equal(cachedAgain.value.data.recetas[0].id_receta, 1, 'el cache no debe compartir referencias mutables');

const keySucursal2 = buildCajaBootstrapCacheKey({ idSucursal: 2, idTipoDepartamento: 10 });
const keyDepartamento2 = buildCajaBootstrapCacheKey({ idSucursal: 1, idTipoDepartamento: 20 });
assert.notEqual(keySucursal1, keySucursal2, 'el cache debe separarse por sucursal');
assert.notEqual(keySucursal1, keyDepartamento2, 'el cache debe separarse por departamento');

const payloadKeys = Object.keys(cachedAgain.value.data);
for (const forbidden of ['clientes', 'productos', 'combos', 'descuentos', 'ventas']) {
  assert.equal(payloadKeys.includes(forbidden), false, `bootstrap no debe incluir ${forbidden}`);
}
assert.ok(cachedAgain.value.data.recetas.every((row) => row.id_tipo_departamento === 10));
assert.equal(cachedAgain.value.data.id_sucursal, 1);

console.log('OK ventas caja bootstrap contract QA');
