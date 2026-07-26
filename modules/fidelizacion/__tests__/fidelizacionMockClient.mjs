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

// Error 25P02 de PostgreSQL: una vez que un statement falla dentro de una
// transaccion, TODA consulta posterior falla asi hasta que se haga ROLLBACK
// (total) o ROLLBACK TO SAVEPOINT. Es exactamente lo que hace inservible
// "capturar el error en JS y seguir" dentro de la misma transaccion.
const buildAbortedTransactionError = () => {
  const err = new Error('current transaction is aborted, commands ignored until end of transaction block');
  err.code = '25P02';
  return err;
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
  // Sentencias ajenas a fidelizacion que la prueba emite deliberadamente para
  // simular la transaccion financiera (p.ej. 'INSERT INTO facturas'). Se
  // aceptan como no-op. Vacio por defecto: el mock sigue siendo estricto y
  // cualquier SQL inesperado de fidelizacion falla la prueba.
  passthroughStatements = [],
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
    nextTelefonoId: 1,
    // Toda escritura al perfil maestro intentada desde el camino de
    // acumulacion queda registrada aqui: las pruebas afirman que esta vacio.
    escriturasPerfilMaestro: [],
    // Simula el UNIQUE real de telefonos.telefono.
    telefonosUnicos: new Set(),
    // Simula el estado de transaccion de PostgreSQL: tras un statement
    // fallido la transaccion queda ABORTADA y todo lo siguiente falla con
    // 25P02 hasta un ROLLBACK (total o a un SAVEPOINT).
    aborted: false,
    savepoints: []
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
      const trimmed = text.trim();
      state.calls.push({ sql: trimmed, params });

      // --- Semantica de transaccion de PostgreSQL -------------------------
      // SAVEPOINT / ROLLBACK TO / RELEASE. El rollback a un savepoint es lo
      // UNICO (junto al rollback total) que saca a la transaccion del estado
      // abortado; por eso aislar una escritura riesgosa en un savepoint es
      // obligatorio y no basta con capturar el error en JavaScript.
      const savepointMatch = /^SAVEPOINT\s+(\S+)/i.exec(trimmed);
      if (savepointMatch) {
        if (state.aborted) throw buildAbortedTransactionError();
        state.savepoints.push(savepointMatch[1]);
        return { rows: [] };
      }
      const rollbackToMatch = /^ROLLBACK TO SAVEPOINT\s+(\S+)/i.exec(trimmed);
      if (rollbackToMatch) {
        const name = rollbackToMatch[1];
        if (!state.savepoints.includes(name)) {
          const err = new Error(`no such savepoint: ${name}`);
          err.code = '3B001';
          throw err;
        }
        // Recupera la transaccion: deja de estar abortada.
        state.aborted = false;
        return { rows: [] };
      }
      const releaseMatch = /^RELEASE SAVEPOINT\s+(\S+)/i.exec(trimmed);
      if (releaseMatch) {
        if (state.aborted) throw buildAbortedTransactionError();
        const idx = state.savepoints.lastIndexOf(releaseMatch[1]);
        if (idx >= 0) state.savepoints.splice(idx, 1);
        return { rows: [] };
      }

      if (trimmed === 'BEGIN') {
        state.aborted = false;
        state.savepoints = [];
        return { rows: [] };
      }
      if (trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        if (trimmed === 'COMMIT' && state.aborted) {
          // PostgreSQL rechaza el COMMIT de una transaccion abortada.
          throw buildAbortedTransactionError();
        }
        state.aborted = false;
        state.savepoints = [];
        // pg_advisory_xact_lock esta scoped a la transaccion: se libera aqui,
        // nunca antes. Si dos clientes comparten lockCoordinator, esto es lo
        // que desbloquea genuinamente al que estaba esperando su turno.
        while (heldLockReleases.length > 0) {
          const release = heldLockReleases.pop();
          release();
        }
        return { rows: [] };
      }

      // Cualquier otro statement dentro de una transaccion abortada falla.
      if (state.aborted) {
        throw buildAbortedTransactionError();
      }

      if (failOn && text.includes(failOn)) {
        state.aborted = true;
        throw new Error(`SIMULATED_FAILURE:${failOn}`);
      }

      // Sentencias de la transaccion financiera simulada por la prueba.
      if (passthroughStatements.some((fragment) => text.includes(fragment))) {
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

      // Fuentes del snapshot historico (buildAccumulationSnapshot). Se
      // reconoce por el alias nombre_maestro, exclusivo de esa consulta, y se
      // evalua ANTES que los handlers genericos de facturas/clientes porque
      // la consulta menciona varias de esas tablas a la vez.
      if (text.includes('AS nombre_maestro')) {
        const facturaId = Number(params[0]);
        const context = state.facturaContexts[facturaId];
        if (!context) return { rows: [] };

        const idPedido = context.id_pedido ?? null;
        const idCliente = context.id_cliente ?? null;
        const pedido = idPedido ? state.pedidos[Number(idPedido)] : null;
        const contacto = idPedido ? state.pedidosContacto[Number(idPedido)] : null;
        const rel = idCliente ? state.clientesRelacional[Number(idCliente)] : null;
        const perfilPlano = idCliente ? getClienteProfile(idCliente) : null;

        return {
          rows: [{
            id_factura: facturaId,
            id_pedido: idPedido,
            id_cliente: idCliente,
            id_sucursal: context.id_sucursal ?? null,
            fecha_referencia: context.fecha_referencia_config ?? null,
            origen_pedido: pedido ? (pedido.origen_pedido ?? null) : null,
            pedido_id_cliente: pedido ? (pedido.id_cliente ?? null) : null,
            nombre_contacto: contacto ? (contacto.nombre_contacto ?? null) : null,
            telefono_normalizado: contacto ? (contacto.telefono_normalizado ?? null) : null,
            // El perfil maestro sale de clientesRelacional cuando el test lo
            // declara (modelo relacional) y, si no, del atajo plano
            // clienteProfiles que usan la mayoria de las pruebas.
            cliente_estado: rel
              ? (rel.estado ?? true)
              : (perfilPlano ? (perfilPlano.estado ?? true) : true),
            nombre_maestro: rel
              ? (rel.nombre ?? null)
              : (perfilPlano ? (perfilPlano.nombre ?? null) : null),
            telefono_maestro: rel
              ? (rel.personaTelefono ?? rel.empresaTelefono ?? null)
              : (perfilPlano ? (perfilPlano.telefono ?? null) : null)
          }]
        };
      }

      // Guardas: el camino de acumulacion NUNCA debe escribir en el perfil
      // maestro. Estas escrituras se registran para que las pruebas puedan
      // afirmar que no ocurrieron (y, si ocurrieran, ademas fallarian por
      // el UNIQUE simulado de telefonos.telefono, igual que en PostgreSQL).
      if (text.includes('INSERT INTO public.telefonos')
        || text.includes('UPDATE public.telefonos')
        || text.includes('UPDATE public.personas')
        || text.includes('UPDATE public.empresas')) {
        state.escriturasPerfilMaestro.push({ sql: trimmed, params });
        const telefono = String(params?.[0] ?? '');
        if (text.includes('INSERT INTO public.telefonos') && state.telefonosUnicos.has(telefono)) {
          // telefonos.telefono es UNIQUE en el esquema real. Ademas de fallar,
          // deja la transaccion abortada (25P02 en todo lo siguiente).
          state.aborted = true;
          const err = new Error('duplicate key value violates unique constraint "telefonos_telefono_key"');
          err.code = '23505';
          throw err;
        }
        if (text.includes('INSERT INTO public.telefonos')) {
          state.telefonosUnicos.add(telefono);
          return { rows: [{ id_telefono: state.nextTelefonoId++ }] };
        }
        return { rows: [] };
      }

      // Tabla de estado de procesamiento por factura (getAccumulationState /
      // ensurePendingAccumulationState / upsertAccumulationState /
      // recordAccumulationRetryableError).
      if (text.includes('INSERT INTO public.fidelizacion_acumulacion_facturas_estado')) {
        const id = Number(params[0]);

        if (text.includes('DO NOTHING')) {
          // ensurePendingAccumulationState (params: [idFactura,
          // fechaReferencia, idPedido, idCliente, idSucursal, origenPedido,
          // nombreSnapshot, telefonoSnapshot, perfilCompletoSnapshot]).
          // Igual que Postgres real, ON CONFLICT DO NOTHING no devuelve fila
          // cuando hubo conflicto.
          const existing = state.estadoFacturas.get(id);
          if (existing) return { rows: [] };
          const nextRow = {
            id_factura: id,
            estado: 'PENDING',
            motivo: null,
            elegibilidad_determinada: null,
            fecha_referencia: params[1] ?? null,
            intentos: 0,
            ultimo_error: null,
            // Snapshot historico congelado en la reserva.
            id_pedido: params[2] ?? null,
            id_cliente: params[3] ?? null,
            id_sucursal: params[4] ?? null,
            origen_pedido: params[5] ?? null,
            nombre_snapshot: params[6] ?? null,
            telefono_snapshot: params[7] ?? null,
            perfil_completo_snapshot: params[8] ?? null
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
          // El UPDATE real solo toca estado/motivo/elegibilidad/fechas/
          // intentos/ultimo_error: las columnas de snapshot conservan lo que
          // grabo la reserva.
          id_pedido: existing?.id_pedido ?? null,
          id_cliente: existing?.id_cliente ?? null,
          id_sucursal: existing?.id_sucursal ?? null,
          origen_pedido: existing?.origen_pedido ?? null,
          nombre_snapshot: existing?.nombre_snapshot ?? null,
          telefono_snapshot: existing?.telefono_snapshot ?? null,
          perfil_completo_snapshot: existing?.perfil_completo_snapshot ?? null,
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

      state.aborted = true;
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
