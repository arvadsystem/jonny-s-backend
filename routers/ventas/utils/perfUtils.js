import { performance } from 'node:perf_hooks';
import {
  VENTAS_PERF_COUNTER_NAMES,
  VENTAS_PERF_STAGE_NAMES
} from '../constants.js';

export const parseTruthyEnv = (value) =>
  ['true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

export const isVentasPerfEnabled = () =>
  process.env.NODE_ENV !== 'production' && parseTruthyEnv(process.env.VENTAS_PERF_LOGS);

let ventasPerfStartupLogged = false;
export const logVentasPerfStartupIfEnabled = () => {
  if (ventasPerfStartupLogged || !isVentasPerfEnabled()) return;
  ventasPerfStartupLogged = true;
  console.info('[ventas:perf:start]', {
    NODE_ENV: process.env.NODE_ENV || null,
    VENTAS_PERF_LOGS: process.env.VENTAS_PERF_LOGS || null,
    VENTAS_USE_RPC_V2: process.env.VENTAS_USE_RPC_V2 || null,
    VENTAS_USE_RPC_TRANSACTION: process.env.VENTAS_USE_RPC_TRANSACTION || null,
    PEDIDO_PENDIENTE_USE_RPC_V1: process.env.PEDIDO_PENDIENTE_USE_RPC_V1 || null,
    VENTAS_CATALOG_CACHE_TTL_MS: process.env.VENTAS_CATALOG_CACHE_TTL_MS || null,
    EMAIL_SCHEDULER_ENABLED: process.env.EMAIL_SCHEDULER_ENABLED || null
  });
};

export const logVentasPerfRoute = (route, extra = {}) => {
  if (!isVentasPerfEnabled()) return;
  console.info('[ventas:perf:route]', {
    route,
    ...extra
  });
};

export function isVentasRpcTransactionEnabled() {
  return String(process.env.VENTAS_USE_RPC_TRANSACTION || '')
    .trim()
    .toLowerCase() === 'true';
}

export function isVentasRpcV2Enabled() {
  return String(process.env.VENTAS_USE_RPC_V2 || '')
    .trim()
    .toLowerCase() === 'true';
}

export function isPedidoPendienteRpcV1Enabled() {
  return String(process.env.PEDIDO_PENDIENTE_USE_RPC_V1 || '')
    .trim()
    .toLowerCase() === 'true';
}

export const measureVentasPerf = async (perf, name, task) => {
  const startedAt = perf?.now?.() || 0;
  try {
    return await task();
  } finally {
    perf?.add?.(name, startedAt);
  }
};

export const createVentasPerfTracker = () => {
  const enabled = isVentasPerfEnabled();
  if (enabled) logVentasPerfStartupIfEnabled();
  const startedAt = enabled ? performance.now() : 0;
  const measures = Object.create(null);
  const counters = Object.create(null);
  let logged = false;

  return {
    enabled,
    now() {
      return enabled ? performance.now() : 0;
    },
    add(name, startedAtMs) {
      if (!enabled || !startedAtMs) return;
      const elapsed = Math.max(0, Math.round(performance.now() - startedAtMs));
      measures[name] = (measures[name] || 0) + elapsed;
    },
    inc(name, by = 1) {
      if (!enabled) return;
      counters[name] = (counters[name] || 0) + Number(by || 1);
    },
    summary(extra = {}) {
      const stages = VENTAS_PERF_STAGE_NAMES.reduce((acc, name) => {
        acc[name] = measures[name] || 0;
        return acc;
      }, {});
      const counterSummary = VENTAS_PERF_COUNTER_NAMES.reduce((acc, name) => {
        acc[name] = counters[name] || 0;
        return acc;
      }, {});

      return {
        ...extra,
        total_ms: enabled ? Math.max(0, Math.round(performance.now() - startedAt)) : 0,
        ...stages,
        ...counterSummary
      };
    },
    log(extra = {}) {
      if (!enabled) return;
      logged = true;
      console.info('[ventas:perf]', this.summary(extra));
    },
    logIfMissing(extra = {}) {
      if (!enabled || logged) return;
      this.log(extra);
    },
    hasLogged() {
      return logged;
    }
  };
};
