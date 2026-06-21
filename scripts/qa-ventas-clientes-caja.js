import assert from 'node:assert/strict';
import pool from '../config/db-connection.js';
import { listClientesCatalogoHandler } from '../routers/ventas/handlers/catalogosHandlers.js';
import {
  buildClienteCreateRequestHash,
  reserveClienteCreateIdempotency,
  saveClienteCreateIdempotencySuccess
} from '../services/clientesCreateIdempotencyService.js';

const invokeCatalog = async (query) => {
  let statusCode = 200;
  let body = null;
  const res = {
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      body = value;
      return value;
    }
  };
  await listClientesCatalogoHandler({ query, method: 'GET' }, res);
  assert.equal(statusCode, 200, `catalogo clientes respondio HTTP ${statusCode}`);
  assert.ok(Array.isArray(body?.data), 'catalogo clientes debe responder data array');
  assert.ok(body?.meta && typeof body.meta === 'object', 'catalogo clientes debe responder meta');
  return body;
};

const assertUniqueClients = (rows) => {
  const ids = rows.map((row) => Number(row.id_cliente));
  assert.equal(new Set(ids).size, ids.length, 'catalogo no debe duplicar id_cliente');
};

try {
  const initial = await invokeCatalog({ limit: '500' });
  assert.deepEqual(initial.data, [], 'busqueda vacia no debe devolver clientes');
  assert.equal(initial.meta.limit, 100, 'limite no debe superar 100');
  assert.equal(initial.meta.has_more, false, 'busqueda vacia no tiene mas resultados');

  const fernandoResponse = await invokeCatalog({ search: 'fernando', limit: '100' });
  const joseResponse = await invokeCatalog({ search: 'jose', limit: '100' });
  const broadResponse = await invokeCatalog({ search: 'an', limit: '500' });
  const fernando = fernandoResponse.data;
  const jose = joseResponse.data;
  const broad = broadResponse.data;
  assert.ok(fernando.length > 20, 'fernando debe devolver todas las coincidencias existentes');
  assert.ok(jose.length > 20, 'jose debe devolver todas las coincidencias existentes');
  assert.equal(broad.length, 100, 'catalogo debe devolver maximo 100 resultados');
  assert.equal(broadResponse.meta.limit, 100, 'meta debe informar limite 100');
  assert.equal(broadResponse.meta.has_more, true, 'meta debe indicar coincidencias adicionales');
  assertUniqueClients(fernando);
  assertUniqueClients(jose);
  assertUniqueClients(broad);

  const joseUpper = (await invokeCatalog({ search: 'JOSE', limit: '100' })).data;
  const joseAccent = (await invokeCatalog({ search: 'José', limit: '100' })).data;
  assert.deepEqual(
    joseUpper.map((row) => row.id_cliente).sort((a, b) => a - b),
    jose.map((row) => row.id_cliente).sort((a, b) => a - b),
    'busqueda debe ignorar mayusculas'
  );
  assert.deepEqual(
    joseAccent.map((row) => row.id_cliente).sort((a, b) => a - b),
    jose.map((row) => row.id_cliente).sort((a, b) => a - b),
    'busqueda debe ignorar tildes'
  );

  const fullNameSample = fernando.find((row) => String(row.nombre_cliente || '').trim().includes(' '));
  assert.ok(fullNameSample, 'se requiere muestra con nombre completo');
  const byFullName = (await invokeCatalog({ search: fullNameSample.nombre_cliente, limit: '100' })).data;
  assert.ok(byFullName.some((row) => row.id_cliente === fullNameSample.id_cliente), 'busqueda por nombre completo');
  assert.equal(byFullName[0].id_cliente, fullNameSample.id_cliente, 'nombre exacto debe ordenar primero');

  const samplesResult = await pool.query(`
    (SELECT 'telefono' AS kind, c.id_cliente, t.telefono AS value
     FROM clientes c JOIN personas p ON p.id_persona=c.id_persona JOIN telefonos t ON t.id_telefono=p.id_telefono
     WHERE COALESCE(c.estado,true)=true AND regexp_replace(t.telefono,'\\D','','g')<>'' LIMIT 1)
    UNION ALL
    (SELECT 'dni', c.id_cliente, p.dni::text
     FROM clientes c JOIN personas p ON p.id_persona=c.id_persona
     WHERE COALESCE(c.estado,true)=true AND NULLIF(TRIM(p.dni::text),'') IS NOT NULL LIMIT 1)
    UNION ALL
    (SELECT 'rtn', c.id_cliente, p.rtn::text
     FROM clientes c JOIN personas p ON p.id_persona=c.id_persona
     WHERE COALESCE(c.estado,true)=true AND NULLIF(TRIM(p.rtn::text),'') IS NOT NULL LIMIT 1)
  `);
  const samples = Object.fromEntries(samplesResult.rows.map((row) => [row.kind, row]));
  assert.ok(samples.telefono && samples.dni && samples.rtn, 'se requieren muestras reales de telefono, DNI y RTN');
  if (samples.telefono) {
    const phoneDigits = String(samples.telefono.value).replace(/\D/g, '');
    const phoneFormatted = phoneDigits.length === 8
      ? `${phoneDigits.slice(0, 4)}-${phoneDigits.slice(4)}`
      : samples.telefono.value;
    for (const search of [phoneDigits, phoneFormatted]) {
      const rows = (await invokeCatalog({ search, limit: '100' })).data;
      assert.ok(rows.some((row) => row.id_cliente === samples.telefono.id_cliente), `busqueda por telefono ${search}`);
    }
  }
  for (const kind of ['dni', 'rtn']) {
    const sample = samples[kind];
    const rows = (await invokeCatalog({ search: sample.value, limit: '100' })).data;
    assert.ok(rows.some((row) => row.id_cliente === sample.id_cliente), `busqueda por ${kind.toUpperCase()}`);
  }
  const byId = (await invokeCatalog({ search: String(samples.telefono.id_cliente), limit: '100' })).data;
  assert.ok(byId.some((row) => row.id_cliente === samples.telefono.id_cliente), 'busqueda por ID exacto');
  assert.equal(byId[0].id_cliente, samples.telefono.id_cliente, 'ID exacto debe ordenar primero');

  const key = 'qa-clientes-idempotency-0001';
  const hash = buildClienteCreateRequestHash({ cliente: { nombre: 'QA' }, quick_create: true });
  let saved = null;
  let inserted = false;
  const fakeClient = {
    async query(text, values) {
      if (/INSERT INTO public\.ventas_idempotency_keys/.test(text)) {
        if (!inserted) {
          inserted = true;
          return { rowCount: 1, rows: [{ idempotency_key: key }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (/SELECT operation, request_hash/.test(text)) {
        return {
          rowCount: 1,
          rows: [{
            operation: 'CLIENTE_FULL_CREATE',
            request_hash: hash,
            status: 'SUCCESS',
            http_status: 201,
            response_body: saved
          }]
        };
      }
      if (/UPDATE public\.ventas_idempotency_keys/.test(text)) {
        saved = JSON.parse(values[4]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`SQL no esperado en QA: ${text}`);
    }
  };
  const reservation = await reserveClienteCreateIdempotency({ client: fakeClient, key, requestHash: hash });
  assert.equal(reservation.reserved, true, 'primera solicitud debe reservar clave');
  await saveClienteCreateIdempotencySuccess({
    client: fakeClient,
    reservation,
    httpStatus: 201,
    responseBody: { ok: true, data: { id_cliente: 999999 } }
  });
  const replay = await reserveClienteCreateIdempotency({ client: fakeClient, key, requestHash: hash });
  assert.equal(replay.replay, true, 'reintento debe reproducir respuesta guardada');
  assert.equal(replay.responseBody.data.id_cliente, 999999, 'reintento debe conservar id_cliente');
  const reused = await reserveClienteCreateIdempotency({
    client: fakeClient,
    key,
    requestHash: buildClienteCreateRequestHash({ cliente: { nombre: 'Otro' } })
  });
  assert.equal(reused.code, 'IDEMPOTENCY_KEY_REUSED', 'misma clave con otro payload debe rechazarse');

  console.log(JSON.stringify({
    ok: true,
    initial: initial.data.length,
    fernando: fernando.length,
    jose: jose.length,
    broad_limited: broad.length,
    has_more: broadResponse.meta.has_more,
    idempotency_replay: replay.replay
  }));
} finally {
  await pool.end();
}
