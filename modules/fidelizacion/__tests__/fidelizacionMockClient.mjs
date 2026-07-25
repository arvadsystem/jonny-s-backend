// Test-only helper: an in-memory stand-in for the pg client used by
// registerFacturaLoyaltyAccumulation and el resto del modulo de fidelizacion,
// para que las pruebas nunca toquen una base de datos real.
const CATALOG_IDS = {
  tipos: { ACUMULACION: 1, CANJE: 2 },
  origenes: { FACTURA: 1, CANJE: 2 },
  estados: { REGISTRADO: 1 }
};

const toDateOrNull = (value) => (value ? new Date(value) : null);

const resolveConfigForDate = (activeConfigs, referenceParam) => {
  const refDate = referenceParam ? new Date(referenceParam) : new Date();
  const matches = activeConfigs.filter((cfg) => {
    const desde = toDateOrNull(cfg.vigente_desde) || new Date(0);
    const hasta = toDateOrNull(cfg.vigente_hasta);
    return desde <= refDate && (!hasta || hasta > refDate);
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => new Date(b.vigente_desde || 0) - new Date(a.vigente_desde || 0));
  return matches[0];
};

export const createFidelizacionMockClient = ({
  elegible = true,
  activeConfig = { lempiras_por_punto: 10 },
  activeConfigs = null,
  saldoInicial = 0,
  movimientos = [],
  facturaContexts = {},
  missingAccumulationIds = [],
  failOn = null,
  releaseError = null
} = {}) => {
  const resolvedConfigs = activeConfigs || (activeConfig
    ? [{ vigente_desde: '1970-01-01T00:00:00Z', vigente_hasta: null, ...activeConfig }]
    : []);

  const state = {
    elegible,
    activeConfigs: resolvedConfigs,
    saldos: new Map(),
    movimientos: [...movimientos],
    facturaContexts: { ...facturaContexts },
    missingAccumulationIds: [...missingAccumulationIds],
    nextMovimientoId: movimientos.length + 1,
    calls: [],
    released: false,
    releaseCallCount: 0
  };

  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      state.calls.push({ sql: text.trim(), params });

      if (failOn && text.includes(failOn)) {
        throw new Error(`SIMULATED_FAILURE:${failOn}`);
      }

      const trimmed = text.trim();
      if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        return { rows: [] };
      }
      if (trimmed.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }

      if (text.includes('NOT EXISTS') && text.includes('FROM public.facturas f')) {
        const limit = Number(params[0]) || 25;
        const rows = state.missingAccumulationIds.slice(0, limit).map((id) => ({ id_factura: id }));
        return { rows };
      }

      if (text.includes('FROM public.facturas f')) {
        const facturaId = Number(params[0]);
        const context = state.facturaContexts[facturaId];
        return { rows: context ? [{ id_factura: facturaId, ...context }] : [] };
      }

      if (text.includes('FROM public.fidelizacion_movimientos fm')) {
        const facturaId = Number(params[0]);
        const match = state.movimientos.find(
          (m) => m.id_factura === facturaId && m.tipo === 'ACUMULACION' && m.origen === 'FACTURA'
        );
        return { rows: match ? [{ id_movimiento: match.id_movimiento }] : [], rowCount: match ? 1 : 0 };
      }

      if (text.includes('FROM public.usuarios_clientes uc')) {
        return { rows: [], rowCount: state.elegible ? 1 : 0 };
      }

      if (text.includes('FROM public.fidelizacion_configuracion_sucursal')) {
        const match = resolveConfigForDate(state.activeConfigs, params[1]);
        return { rows: match ? [match] : [] };
      }

      if (text.includes('cat_fidelizacion_tipos_movimiento') && text.includes('SELECT')) {
        const code = String(params[0] || '').toUpperCase();
        const id = CATALOG_IDS.tipos[code];
        return { rows: id ? [{ id_catalogo: id, codigo: code, nombre: code, estado: true }] : [] };
      }

      if (text.includes('cat_fidelizacion_origenes_movimiento') && text.includes('SELECT')) {
        const code = String(params[0] || '').toUpperCase();
        const id = CATALOG_IDS.origenes[code];
        return { rows: id ? [{ id_catalogo: id, codigo: code, nombre: code, estado: true }] : [] };
      }

      if (text.includes('cat_fidelizacion_estados_canje') && text.includes('SELECT')) {
        const code = String(params[0] || '').toUpperCase();
        const id = CATALOG_IDS.estados[code];
        return { rows: id ? [{ id_catalogo: id, codigo: code, nombre: code, estado: true }] : [] };
      }

      if (text.includes('INSERT INTO public.fidelizacion_saldos_cliente')) {
        const idCliente = Number(params[0]);
        if (!state.saldos.has(idCliente)) {
          state.saldos.set(idCliente, {
            id_cliente: idCliente,
            puntos_disponibles: saldoInicial,
            puntos_acumulados_total: saldoInicial,
            puntos_canjeados_total: 0
          });
        }
        return { rows: [] };
      }

      if (text.includes('FROM public.fidelizacion_saldos_cliente') && text.includes('FOR UPDATE')) {
        const idCliente = Number(params[0]);
        return { rows: [state.saldos.get(idCliente)] };
      }

      if (text.includes('UPDATE public.fidelizacion_saldos_cliente')) {
        const [nextSaldo, acumulados, canjeados, idCliente] = params;
        state.saldos.set(Number(idCliente), {
          id_cliente: Number(idCliente),
          puntos_disponibles: Number(nextSaldo),
          puntos_acumulados_total: Number(acumulados),
          puntos_canjeados_total: Number(canjeados)
        });
        return { rows: [] };
      }

      if (text.includes('UPDATE public.clientes')) {
        return { rows: [] };
      }

      if (text.includes('INSERT INTO public.fidelizacion_movimientos')) {
        const idMovimiento = state.nextMovimientoId++;
        state.movimientos.push({
          id_movimiento: idMovimiento,
          id_factura: params[7] ? Number(params[7]) : null,
          tipo: 'ACUMULACION',
          origen: 'FACTURA'
        });
        return { rows: [{ id_movimiento: idMovimiento }] };
      }

      throw new Error(`UNEXPECTED_MOCK_QUERY: ${text.slice(0, 80)}`);
    },
    release() {
      state.releaseCallCount += 1;
      if (releaseError) {
        throw releaseError instanceof Error ? releaseError : new Error(String(releaseError));
      }
      state.released = true;
    }
  };

  return { client, state };
};
