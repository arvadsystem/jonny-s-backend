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
  estadoFacturasIniciales = {},
  // Menu publico (backfillClienteTelefonoDesdePedidoContacto): simulacion
  // relacional minima, independiente del clienteProfiles plano de arriba
  // (que solo alimenta fetchClienteProfileForFidelizacion). pedidos:
  // {id_pedido: {id_cliente}}. pedidosContacto: {id_pedido: {telefono_normalizado}}.
  // clientesRelacional: {id_cliente: {id_persona|id_empresa, personaTelefono|empresaTelefono}}.
  pedidos = {},
  pedidosContacto = {},
  clientesRelacional = {},
  failOn = null,
  releaseError = null,
  // Bloqueante 3 (prueba de concurrencia real): dos clientes mock
  // independientes pueden compartir el MISMO state (misma "base de datos")
  // pasando sharedState = otroCliente.state, y el MISMO lockCoordinator
  // (ver fidelizacionLockCoordinator.mjs) para que pg_advisory_xact_lock
  // bloquee de verdad entre ambos, igual que Postgres real.
  sharedState = null,
  lockCoordinator = null
} = {}) => {
  const rawConfigs = activeConfigs || (activeConfig ? [activeConfig] : []);
  const resolvedConfigs = rawConfigs.map((cfg) => ({
    vigente_desde: '1970-01-01T00:00:00Z',
    vigente_hasta: null,
    acumulacion_habilitada: true,
    ...cfg
  }));

  const state = sharedState || {
    activeConfigs: resolvedConfigs,
    saldos: new Map(),
    movimientos: [...movimientos],
    facturaContexts: { ...facturaContexts },
    clienteProfiles: Object.fromEntries(
      Object.entries(clienteProfiles).map(([id, profile]) => [Number(id), profile])
    ),
    defaultClienteProfile,
    missingAccumulationIds: missingAccumulationIds ? [...missingAccumulationIds] : null,
    // fidelizacion_acumulacion_facturas_estado: Map<id_factura, fila>. Refleja
    // el mismo guard que el INSERT ... ON CONFLICT real: nunca degrada un
    // estado terminal (PROCESSED/SKIPPED_TERMINAL) ya grabado.
    estadoFacturas: new Map(
      Object.entries(estadoFacturasIniciales).map(([id, row]) => [Number(id), {
        id_factura: Number(id),
        estado: 'PENDING',
        motivo: null,
        elegibilidad_determinada: null,
        fecha_referencia: null,
        intentos: 0,
        ...row
      }])
    ),
    nextMovimientoId: movimientos.length + 1,
    calls: [],
    released: false,
    releaseCallCount: 0,
    pedidos: Object.fromEntries(Object.entries(pedidos).map(([id, row]) => [Number(id), row])),
    pedidosContacto: Object.fromEntries(Object.entries(pedidosContacto).map(([id, row]) => [Number(id), row])),
    // clientesRelacional: valores por defecto (sin persona/empresa/telefono
    // previo) mezclados con lo que declare el test.
    clientesRelacional: Object.fromEntries(
      Object.entries(clientesRelacional).map(([id, row]) => [Number(id), {
        idPersona: null,
        idEmpresa: null,
        personaIdTelefono: null,
        personaTelefono: null,
        empresaIdTelefono: null,
        empresaTelefono: null,
        ...row
      }])
    ),
    telefonos: new Map(),
    nextTelefonoId: 1
  };

  // Locks que ESTE cliente (esta "conexion") tiene tomados en la
  // transaccion en curso; se liberan en el proximo COMMIT/ROLLBACK, igual
  // que pg_advisory_xact_lock real (scoped a la transaccion, no a la query).
  const heldLockReleases = [];

  const getClienteProfile = (idCliente) => {
    const override = state.clienteProfiles[Number(idCliente)];
    return override === undefined ? state.defaultClienteProfile : override;
  };

  const hasMovimiento = (idFactura) => state.movimientos.some(
    (m) => m.id_factura === Number(idFactura) && m.tipo === 'ACUMULACION' && m.origen === 'FACTURA'
  );

  const isRetryableOrNoState = (idFactura) => {
    const row = state.estadoFacturas.get(Number(idFactura));
    return !row || row.estado === 'PENDING' || row.estado === 'RETRYABLE_ERROR';
  };

  // Recalcula la lista de candidatos "pagados sin movimiento" a partir de
  // facturaContexts, replicando los mismos filtros que la consulta real:
  // pago completo, sin movimiento, sin fila terminal en
  // fidelizacion_acumulacion_facturas_estado, y fuera del periodo de gracia
  // (fecha_referencia_config <= ahora - graceMs). Ya NO filtra por perfil de
  // cliente ni por configuracion vigente (eso es exactamente lo que causaba
  // la acumulacion retroactiva: ver fidelizacionRepository.js). Si el test
  // declaro missingAccumulationIds explicitamente, se respeta tal cual
  // (compatibilidad con pruebas mas simples; el periodo de gracia no aplica
  // a esa via de compatibilidad).
  const computeMissingAccumulationCandidates = (cursor, limit, graceMs = 0) => {
    if (state.missingAccumulationIds !== null) {
      return state.missingAccumulationIds.filter((id) => id > cursor).slice(0, limit);
    }

    const graceCutoff = Date.now() - graceMs;
    const candidates = Object.entries(state.facturaContexts)
      .map(([idStr, context]) => ({ id: Number(idStr), context }))
      .filter(({ id, context }) => {
        if (id <= cursor) return false;
        if (!context.id_cliente) return false;
        if (!isContextFullyPaid(context)) return false;
        if (hasMovimiento(id)) return false;
        if (!isRetryableOrNoState(id)) return false;
        const refMs = context.fecha_referencia_config ? new Date(context.fecha_referencia_config).getTime() : NaN;
        if (Number.isFinite(refMs) && refMs > graceCutoff) return false;
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
      if (trimmed === 'BEGIN') {
        return { rows: [] };
      }
      if (trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        // pg_advisory_xact_lock esta scoped a la transaccion: se libera aqui,
        // nunca antes. Si dos clientes comparten lockCoordinator, esto es lo
        // que desbloquea genuinamente al que estaba esperando su turno.
        while (heldLockReleases.length > 0) {
          const release = heldLockReleases.pop();
          release();
        }
        return { rows: [] };
      }
      if (trimmed.includes('pg_advisory_xact_lock')) {
        if (lockCoordinator) {
          const key = params.join(':');
          const release = await lockCoordinator.acquire(key);
          heldLockReleases.push(release);
        }
        return { rows: [] };
      }

      // Deteccion de columna clientes.id_empresa_cliente (buildClienteEmpresaRelationSql):
      // se simula un esquema SIN esa columna (empresaRelationExpr cae a c.id_empresa).
      if (text.includes('information_schema.columns') && text.includes('clientes')) {
        return { rowCount: 0, rows: [] };
      }

      // backfillClienteTelefonoDesdePedidoContacto (services/fidelizacionService.js):
      // dueno del pedido (guard de cuentas divididas).
      if (text.includes('SELECT id_cliente') && text.includes('FROM public.pedidos') && !text.includes('LEFT JOIN')) {
        const idPedido = Number(params[0]);
        const row = state.pedidos[idPedido];
        return { rows: row ? [{ id_cliente: row.id_cliente }] : [] };
      }

      // backfillClienteTelefonoDesdePedidoContacto: candidato persona/empresa
      // (FOR UPDATE OF c la distingue de la query de perfil de mas abajo).
      if (text.includes('FROM public.clientes c') && text.includes('FOR UPDATE OF c')) {
        const idCliente = Number(params[0]);
        const rel = state.clientesRelacional[idCliente];
        if (!rel) return { rows: [] };
        return {
          rows: [{
            id_persona: rel.idPersona,
            id_empresa: rel.idEmpresa,
            persona_id_telefono: rel.personaIdTelefono,
            persona_telefono: rel.personaTelefono,
            empresa_id_telefono: rel.empresaIdTelefono,
            empresa_telefono: rel.empresaTelefono
          }]
        };
      }

      // backfillClienteTelefonoDesdePedidoContacto: telefono mas reciente
      // capturado en el pedido (menu publico o pedidos-pendientes del POS).
      if (text.includes('FROM public.pedidos_contacto')) {
        const idPedido = Number(params[0]);
        const row = state.pedidosContacto[idPedido];
        return { rows: row ? [{ telefono_normalizado: row.telefono_normalizado ?? null }] : [] };
      }

      if (text.includes('UPDATE public.telefonos SET telefono')) {
        const [telefono, idTelefono] = params;
        state.telefonos.set(Number(idTelefono), telefono);
        for (const entry of Object.values(state.clientesRelacional)) {
          if (entry.personaIdTelefono === Number(idTelefono)) entry.personaTelefono = telefono;
          if (entry.empresaIdTelefono === Number(idTelefono)) entry.empresaTelefono = telefono;
        }
        return { rows: [] };
      }

      if (text.includes('INSERT INTO public.telefonos')) {
        const [telefono] = params;
        const idTelefono = state.nextTelefonoId++;
        state.telefonos.set(idTelefono, telefono);
        return { rows: [{ id_telefono: idTelefono }] };
      }

      if (text.includes('UPDATE public.personas SET id_telefono')) {
        const [idTelefono, idPersona] = params;
        const entry = Object.values(state.clientesRelacional).find((rel) => rel.idPersona === Number(idPersona));
        if (entry) {
          entry.personaIdTelefono = Number(idTelefono);
          entry.personaTelefono = state.telefonos.get(Number(idTelefono)) ?? entry.personaTelefono;
        }
        return { rows: [] };
      }

      if (text.includes('UPDATE public.empresas SET id_telefono')) {
        const [idTelefono, idEmpresa] = params;
        const entry = Object.values(state.clientesRelacional).find((rel) => rel.idEmpresa === Number(idEmpresa));
        if (entry) {
          entry.empresaIdTelefono = Number(idTelefono);
          entry.empresaTelefono = state.telefonos.get(Number(idTelefono)) ?? entry.empresaTelefono;
        }
        return { rows: [] };
      }

      // Tabla de estado de procesamiento por factura (getAccumulationState /
      // ensurePendingAccumulationState / upsertAccumulationState /
      // recordAccumulationRetryableError).
      if (text.includes('INSERT INTO public.fidelizacion_acumulacion_facturas_estado')) {
        const id = Number(params[0]);

        if (text.includes('DO NOTHING')) {
          // ensurePendingAccumulationState: solo reserva PENDING si no
          // existe fila (params: [idFactura, fechaReferencia]). Igual que
          // Postgres real, ON CONFLICT DO NOTHING no devuelve fila cuando
          // hubo conflicto.
          const existing = state.estadoFacturas.get(id);
          if (existing) return { rows: [] };
          const fechaReferencia = params[1] ?? null;
          const nextRow = {
            id_factura: id,
            estado: 'PENDING',
            motivo: null,
            elegibilidad_determinada: null,
            fecha_referencia: fechaReferencia,
            intentos: 0,
            ultimo_error: null
          };
          state.estadoFacturas.set(id, nextRow);
          return { rows: [nextRow] };
        }

        // upsertAccumulationState: DO UPDATE (params: [idFactura, estado,
        // motivo, elegibilidadDeterminada, fechaReferencia, ultimoError]).
        const [, estado, motivo, elegibilidadDeterminada, fechaReferencia, ultimoError] = params;
        const existing = state.estadoFacturas.get(id);

        // Mismo guard que el WHERE del ON CONFLICT DO UPDATE real: nunca
        // degrada un estado terminal ya grabado.
        if (existing && existing.estado !== 'PENDING' && existing.estado !== 'RETRYABLE_ERROR') {
          return { rows: [existing] };
        }

        const nextRow = {
          id_factura: id,
          estado,
          motivo: motivo ?? null,
          elegibilidad_determinada: elegibilidadDeterminada ?? null,
          fecha_referencia: fechaReferencia ?? existing?.fecha_referencia ?? null,
          intentos: (existing?.intentos || 0) + 1,
          ultimo_error: ultimoError ?? null
        };
        state.estadoFacturas.set(id, nextRow);
        return { rows: [nextRow] };
      }

      if (text.includes('FROM public.fidelizacion_acumulacion_facturas_estado')) {
        const id = Number(params[0]);
        const row = state.estadoFacturas.get(id);
        return { rows: row ? [row] : [] };
      }

      if (text.includes('NOT EXISTS') && text.includes('FROM public.facturas f')) {
        const cursor = Number(params[0]) || 0;
        const limit = Number(params[1]) || 25;
        const graceMs = Number(params[3]) || 0;
        const ids = computeMissingAccumulationCandidates(cursor, limit, graceMs);
        return { rows: ids.map((id) => ({ id_factura: id })) };
      }

      if (text.includes('FROM public.facturas f')) {
        const facturaId = Number(params[0]);
        const context = state.facturaContexts[facturaId];
        return { rows: context ? [{ id_factura: facturaId, ...context }] : [] };
      }

      // Perfil de cliente (fetchClienteProfileForFidelizacion): activo,
      // nombre (persona/empresa) y telefono asociado. Si el test declaro
      // clientesRelacional para este cliente, el telefono se lee de ahi (asi
      // el efecto de backfillClienteTelefonoDesdePedidoContacto -que solo
      // escribe en clientesRelacional/telefonos- es visible aqui, igual que
      // en Postgres real seria la MISMA fila). Sin clientesRelacional
      // declarado, se usa el atajo plano clienteProfiles de siempre.
      if (text.includes('FROM public.clientes c') && text.includes('LEFT JOIN public.personas p')) {
        const idCliente = Number(params[0]);
        const profile = getClienteProfile(idCliente);
        if (!profile) return { rows: [] };
        const rel = state.clientesRelacional[idCliente];
        const telefonoRelacional = rel ? (rel.personaTelefono ?? rel.empresaTelefono ?? null) : undefined;
        return {
          rows: [{
            id_cliente: idCliente,
            estado: profile.estado ?? true,
            nombre: profile.nombre ?? null,
            telefono: telefonoRelacional !== undefined ? telefonoRelacional : (profile.telefono ?? null)
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
