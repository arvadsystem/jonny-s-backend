// Test-only helper: an in-memory stand-in for the pg client used by
// registerFacturaLoyaltyAccumulation y el resto del modulo de fidelizacion,
// para que las pruebas nunca toquen una base de datos real.
const CATALOG_IDS = {
  tipos: { ACUMULACION: 1, CANJE: 2 },
  origenes: { FACTURA: 1, CANJE: 2 },
  estados: { REGISTRADO: 1 }
};

// Perfil "seguro" por defecto: activo, con nombre y telefono validos. Asi,
// las pruebas que no les importa el perfil del cliente (la mayoria de las
// existentes antes de esta regla) no tienen que declararlo explicitamente.
// Las que SI quieren un perfil incompleto lo indican via clienteProfiles.
const DEFAULT_CLIENTE_PROFILE = { estado: true, nombre: 'Cliente Demo', telefono: '9999-9999' };

const toDateOrNull = (value) => (value ? new Date(value) : null);

// Refleja el WHERE real de getActiveFidelizacionConfig: con referenceDate se
// ignora "estado" (config historica), sin referenceDate se exige estado=true.
const resolveConfigForDate = (activeConfigs, referenceParam) => {
  const refDate = referenceParam ? new Date(referenceParam) : new Date();
  const matches = activeConfigs.filter((cfg) => {
    if (!referenceParam && cfg.estado === false) return false;
    const desde = toDateOrNull(cfg.vigente_desde) || new Date(0);
    const hasta = toDateOrNull(cfg.vigente_hasta);
    return desde <= refDate && (!hasta || hasta > refDate);
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => new Date(b.vigente_desde || 0) - new Date(a.vigente_desde || 0));
  return matches[0];
};

const isContextFullyPaid = (context) => {
  if (!context) return false;
  if (!context.tiene_pago_control) return true;
  const estadoCodigo = String(context.pago_control_estado_codigo || '').trim().toUpperCase();
  const montoPendiente = Number(context.pago_control_monto_pendiente ?? NaN);
  return estadoCodigo === 'PAGADO_CONFIRMADO' && montoPendiente === 0;
};

export const createFidelizacionMockClient = ({
  activeConfig = { lempiras_por_punto: 10 },
  activeConfigs = null,
  saldoInicial = 0,
  movimientos = [],
  facturaContexts = {},
  clienteProfiles = {},
  defaultClienteProfile = DEFAULT_CLIENTE_PROFILE,
  missingAccumulationIds = null,
  failOn = null,
  releaseError = null
} = {}) => {
  const rawConfigs = activeConfigs || (activeConfig ? [activeConfig] : []);
  const resolvedConfigs = rawConfigs.map((cfg) => ({
    vigente_desde: '1970-01-01T00:00:00Z',
    vigente_hasta: null,
    acumulacion_habilitada: true,
    ...cfg
  }));

  const state = {
    activeConfigs: resolvedConfigs,
    saldos: new Map(),
    movimientos: [...movimientos],
    facturaContexts: { ...facturaContexts },
    clienteProfiles: Object.fromEntries(
      Object.entries(clienteProfiles).map(([id, profile]) => [Number(id), profile])
    ),
    defaultClienteProfile,
    missingAccumulationIds: missingAccumulationIds ? [...missingAccumulationIds] : null,
    nextMovimientoId: movimientos.length + 1,
    calls: [],
    released: false,
    releaseCallCount: 0
  };

  const getClienteProfile = (idCliente) => {
    const override = state.clienteProfiles[Number(idCliente)];
    return override === undefined ? state.defaultClienteProfile : override;
  };

  // Mismo criterio que isClienteProfileComplete en services/fidelizacionService.js:
  // activo + nombre no vacio + telefono con exactamente 8 digitos (normalizePhoneHN).
  const isClienteProfileValid = (idCliente) => {
    const profile = getClienteProfile(idCliente);
    if (!profile) return false;
    const nombreValido = String(profile.nombre ?? '').trim().length > 0;
    const digits = String(profile.telefono ?? '').replace(/\D/g, '');
    const telefonoValido = digits.length === 8;
    return Boolean(profile.estado ?? true) && nombreValido && telefonoValido;
  };

  const hasMovimiento = (idFactura) => state.movimientos.some(
    (m) => m.id_factura === Number(idFactura) && m.tipo === 'ACUMULACION' && m.origen === 'FACTURA'
  );

  // Recalcula la lista de candidatos "pagados sin movimiento" a partir de
  // facturaContexts, replicando los mismos filtros que la consulta real
  // (perfil de cliente completo, switch+tasa historicos, pago completo, sin
  // movimiento). Si el test declaro missingAccumulationIds explicitamente,
  // se respeta tal cual (compatibilidad con pruebas mas simples).
  const computeMissingAccumulationCandidates = (cursor, limit) => {
    if (state.missingAccumulationIds !== null) {
      return state.missingAccumulationIds.filter((id) => id > cursor).slice(0, limit);
    }

    const candidates = Object.entries(state.facturaContexts)
      .map(([idStr, context]) => ({ id: Number(idStr), context }))
      .filter(({ id, context }) => {
        if (id <= cursor) return false;
        if (!context.id_cliente) return false;
        if (!isContextFullyPaid(context)) return false;
        if (!isClienteProfileValid(context.id_cliente)) return false;
        const matchedConfig = resolveConfigForDate(state.activeConfigs, context.fecha_referencia_config);
        if (!matchedConfig) return false;
        if (!matchedConfig.acumulacion_habilitada) return false;
        if (!(Number(matchedConfig.lempiras_por_punto) > 0)) return false;
        if (hasMovimiento(id)) return false;
        return true;
      })
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map(({ id }) => id);

    return candidates;
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

      // Deteccion de columna clientes.id_empresa_cliente (buildClienteEmpresaRelationSql):
      // se simula un esquema SIN esa columna (empresaRelationExpr cae a c.id_empresa).
      if (text.includes('information_schema.columns') && text.includes('clientes')) {
        return { rowCount: 0, rows: [] };
      }

      if (text.includes('NOT EXISTS') && text.includes('FROM public.facturas f')) {
        const cursor = Number(params[0]) || 0;
        const limit = Number(params[1]) || 25;
        const ids = computeMissingAccumulationCandidates(cursor, limit);
        return { rows: ids.map((id) => ({ id_factura: id })) };
      }

      if (text.includes('FROM public.facturas f')) {
        const facturaId = Number(params[0]);
        const context = state.facturaContexts[facturaId];
        return { rows: context ? [{ id_factura: facturaId, ...context }] : [] };
      }

      // Perfil de cliente (fetchClienteProfileForFidelizacion): activo,
      // nombre (persona/empresa) y telefono asociado.
      if (text.includes('FROM public.clientes c') && text.includes('LEFT JOIN public.personas p')) {
        const idCliente = Number(params[0]);
        const profile = getClienteProfile(idCliente);
        if (!profile) return { rows: [] };
        return {
          rows: [{
            id_cliente: idCliente,
            estado: profile.estado ?? true,
            nombre: profile.nombre ?? null,
            telefono: profile.telefono ?? null
          }]
        };
      }

      if (text.includes('FROM public.fidelizacion_movimientos fm')) {
        const facturaId = Number(params[0]);
        const match = state.movimientos.find(
          (m) => m.id_factura === facturaId && m.tipo === 'ACUMULACION' && m.origen === 'FACTURA'
        );
        return { rows: match ? [{ id_movimiento: match.id_movimiento }] : [], rowCount: match ? 1 : 0 };
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
