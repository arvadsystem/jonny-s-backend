import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const bootstrapDuration = new Trend('caja_bootstrap_duration', true);
const crossSucursal = new Counter('caja_cross_sucursal');
const baseUrl = String(__ENV.K6_BASE_URL || '').replace(/\/$/, '');
const sucursal1 = Number(__ENV.K6_SUCURSAL_1 || 0);
const sucursal2 = Number(__ENV.K6_SUCURSAL_2 || 0);
const authCookie = String(__ENV.K6_AUTH_COOKIE || '').trim();

if (!baseUrl || !sucursal1 || !sucursal2 || !authCookie) {
  throw new Error('Configura K6_BASE_URL, K6_SUCURSAL_1, K6_SUCURSAL_2 y K6_AUTH_COOKIE.');
}

export const options = {
  scenarios: {
    sucursal_1: { executor: 'constant-vus', vus: 20, duration: '10m', exec: 'sucursalUno' },
    sucursal_2: { executor: 'constant-vus', vus: 20, duration: '10m', exec: 'sucursalDos' }
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<=2000'],
    caja_bootstrap_duration: ['p(95)<=500'],
    caja_cross_sucursal: ['count==0']
  }
};

const params = {
  headers: {
    Cookie: authCookie,
    Accept: 'application/json'
  },
  tags: { module: 'ventas-caja' }
};

const runSucursal = (idSucursal) => {
  const bootstrap = http.get(`${baseUrl}/api/ventas/caja/bootstrap?id_sucursal=${idSucursal}`, params);
  bootstrapDuration.add(bootstrap.timings.duration);
  let body = null;
  try { body = bootstrap.json(); } catch (_) { body = null; }
  const returnedSucursal = Number(body?.data?.id_sucursal || 0);
  if (returnedSucursal && returnedSucursal !== idSucursal) crossSucursal.add(1);
  check(bootstrap, {
    'bootstrap 200': (res) => res.status === 200,
    'sucursal correcta': () => returnedSucursal === idSucursal,
    'sin payload diferido': () => !body?.data?.clientes && !body?.data?.productos && !body?.data?.combos && !body?.data?.ventas
  });

  http.get(`${baseUrl}/api/ventas/catalogos/productos?id_sucursal=${idSucursal}`, params);
  http.get(`${baseUrl}/api/ventas/catalogos/clientes?search=99&limit=20`, params);
  sleep(1);
};

export function sucursalUno() { runSucursal(sucursal1); }
export function sucursalDos() { runSucursal(sucursal2); }
