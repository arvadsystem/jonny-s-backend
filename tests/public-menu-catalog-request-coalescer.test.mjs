import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublicCatalogRequestKey,
  fetchCoalescedPublicCatalog,
  getPublicCatalogRequestCoalescerState
} from '../routers/public_menu/publicMenuCatalogRequestCoalescer.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('solicitudes simultaneas del mismo catalogo comparten un solo loader', async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await wait(20);
    return { branch: 1 };
  };

  const results = await Promise.all(
    Array.from({ length: 8 }, () => fetchCoalescedPublicCatalog({ idSucursal: 1, tipoPedido: 'dine-in' }, loader))
  );

  assert.equal(calls, 1);
  assert.deepEqual(results, Array.from({ length: 8 }, () => ({ branch: 1 })));
  assert.equal(getPublicCatalogRequestCoalescerState().in_flight, 0);
});

test('sucursales y tipos de pedido distintos no comparten trabajo', async () => {
  const keys = [
    buildPublicCatalogRequestKey({ idSucursal: 1, tipoPedido: 'dine-in' }),
    buildPublicCatalogRequestKey({ idSucursal: 2, tipoPedido: 'dine-in' }),
    buildPublicCatalogRequestKey({ idSucursal: 1, tipoPedido: 'pickup' })
  ];

  assert.equal(new Set(keys).size, 3);

  let calls = 0;
  await Promise.all([
    fetchCoalescedPublicCatalog({ idSucursal: 1, tipoPedido: 'dine-in' }, async () => { calls += 1; return 1; }),
    fetchCoalescedPublicCatalog({ idSucursal: 2, tipoPedido: 'dine-in' }, async () => { calls += 1; return 2; }),
    fetchCoalescedPublicCatalog({ idSucursal: 1, tipoPedido: 'pickup' }, async () => { calls += 1; return 3; })
  ]);

  assert.equal(calls, 3);
});

test('una respuesta terminada no queda cacheada indefinidamente', async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return calls;
  };

  const first = await fetchCoalescedPublicCatalog({ idSucursal: 1, tipoPedido: 'delivery' }, loader);
  const second = await fetchCoalescedPublicCatalog({ idSucursal: 1, tipoPedido: 'delivery' }, loader);

  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(calls, 2);
});

test('un error libera la clave para permitir reintento', async () => {
  await assert.rejects(
    fetchCoalescedPublicCatalog(
      { idSucursal: 1, tipoPedido: 'pickup' },
      async () => { throw new Error('fallo esperado'); }
    ),
    /fallo esperado/
  );

  const recovered = await fetchCoalescedPublicCatalog(
    { idSucursal: 1, tipoPedido: 'pickup' },
    async () => 'ok'
  );

  assert.equal(recovered, 'ok');
  assert.equal(getPublicCatalogRequestCoalescerState().in_flight, 0);
});
