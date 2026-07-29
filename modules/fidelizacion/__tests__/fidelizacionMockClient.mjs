// Test-only helper: an in-memory stand-in for the pg client used by
// registerFacturaLoyaltyAccumulation y el resto del modulo de fidelizacion,
// para que las pruebas nunca toquen una base de datos real.
const CATALOG_IDS = {
  tipos: { ACUMULACION: 1, CANJE: 2, REVERSO: 3, COMPENSACION: 4 },
  origenes: { FACTURA: 1, CANJE: 2, REVERSO_FACTURA: 3, AJUSTE_PENDIENTE: 4 },
  estados: { REGISTRADO: 1 }
};

// Perfil "seguro" por defecto: activo, con nombre y telefono validos. Asi,
// las pruebas que no les importa el perfil del cliente (la mayoria de las
// existentes antes de esta regla) no tienen que declararlo explicitamente.
// Las que SI quieren un perfil incompleto lo indican via clienteProfiles.
const DEFAULT_CLIENTE_PROFILE = { estado: true, nombre: 'Cliente Demo', telefono: '9999-9999' };

const toDateOrNull = (value) => (value ? new Date(value) : null);

// ---------------------------------------------------------------------------
// Modelo fiel de `timestamp without time zone` de PostgreSQL
// ---------------------------------------------------------------------------
// Varias columnas del sistema son `timestamp without time zone` (sin offset):
// el valor guardado es un reloj de pared, y el INSTANTE que representa depende
// de la zona con la que se interprete.
//
//   - facturas.fecha_hora_facturacion y pedidos_pago_control.fecha_pago_confirmado
//     guardan hora LOCAL de Honduras.
//   - fidelizacion_configuracion_sucursal.vigente_desde/vigente_hasta guardan UTC.
//
// PostgreSQL resuelve esa interpretacion asi:
//   - `naked AT TIME ZONE 'X'`      -> se interpreta como hora local de X.
//   - comparacion naked vs timestamptz SIN AT TIME ZONE -> se interpreta con el
//     TimeZone de la SESION (en este backend, UTC).
//
// Estas dos funciones reproducen exactamente esa regla, y la zona se deduce del
// TEXTO SQL REAL que emite el codigo de produccion. Asi la prueba no es una
// asercion de regex sobre el SQL: es la MISMA semantica de PostgreSQL corriendo
// sobre la consulta real. Si alguien quitara el `AT TIME ZONE 'America/Tegucigalpa'`
// del repositorio, este mock volveria a interpretar la hora local como UTC
// -igual que PostgreSQL- y las pruebas del defecto VTA-00004 fallarian.
//
// Honduras no aplica horario de verano: offset fijo UTC-6.
const HONDURAS_UTC_OFFSET_MINUTES = -360;
const SESSION_TIME_ZONE = 'UTC';

const ZONE_OFFSET_MINUTES = {
  UTC: 0,
  'America/Tegucigalpa': HONDURAS_UTC_OFFSET_MINUTES
};

// Convierte un reloj de pared sin zona ('2026-07-28 12:08:57') en el instante
// absoluto que representa cuando se interpreta en `zone`. Nunca usa
// `new Date(stringSinOffset)` (que dependeria del TZ del proceso Node): arma el
// instante con Date.UTC y aplica el offset de la zona de forma explicita.
export const nakedTimestampToInstant = (naked, zone = SESSION_TIME_ZONE) => {
  if (naked === null || naked === undefined || naked === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(naked).trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const wallClockAsUtcMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second || 0)
  );
  const offsetMinutes = ZONE_OFFSET_MINUTES[zone] ?? 0;
  return new Date(wallClockAsUtcMs - offsetMinutes * 60000);
};

// Zona con la que PostgreSQL interpretara la columna sin zona en ESTA consulta:
// la declarada con AT TIME ZONE si el SQL real la trae, o el TimeZone de la
// sesion (UTC) si la consulta no declara ninguna.
export const zoneAppliedBySql = (sqlText, columnHint = null) => {
  const source = String(sqlText || '');
  if (columnHint) {
    const scoped = new RegExp(`${columnHint}\\s+AT TIME ZONE '([^']+)'`).exec(source);
    if (scoped) return scoped[1];
  }
  const generic = /AT TIME ZONE '([^']+)'/.exec(source);
  return generic ? generic[1] : SESSION_TIME_ZONE;
};

// Instante de referencia de una factura tal como lo devolveria PostgreSQL.
// Compatibilidad: si la prueba declara `fecha_referencia_config` como ISO con
// offset (el estilo de las pruebas previas), ya es un instante y se usa tal
// cual -no se vuelve a convertir (evita la doble conversion)-. Solo cuando la
// prueba declara `fecha_referencia_local_naked` (lo que fisicamente hay en la
// columna `timestamp without time zone`) se aplica la semantica de zona.
const resolveFacturaReferenceInstant = (context, sqlText) => {
  if (context?.fecha_referencia_local_naked) {
    return nakedTimestampToInstant(context.fecha_referencia_local_naked, zoneAppliedBySql(sqlText));
  }
  return context?.fecha_referencia_config ?? null;
};

// Igual para la vigencia de configuracion: `vigente_desde_naked`/
// `vigente_hasta_naked` representan lo guardado en columnas sin zona (UTC).
const resolveConfigBoundary = (cfg, nakedKey, isoKey, sqlText) => {
  if (cfg?.[nakedKey]) {
    return nakedTimestampToInstant(cfg[nakedKey], zoneAppliedBySql(sqlText, 'fcs\\.vigente_desde'));
  }
  return toDateOrNull(cfg?.[isoKey]);
};

// Refleja el WHERE real de getActiveFidelizacionConfig: con referenceDate se
// ignora "estado" (config historica), sin referenceDate se exige estado=true.
// vigente_desde inclusivo (<=), vigente_hasta exclusivo (>).
const resolveConfigForDate = (activeConfigs, referenceParam, sqlText = '') => {
  const refDate = referenceParam ? new Date(referenceParam) : new Date();
  const matches = activeConfigs.filter((cfg) => {
    if (!referenceParam && cfg.estado === false) return false;
    const desde = resolveConfigBoundary(cfg, 'vigente_desde_naked', 'vigente_desde', sqlText) || new Date(0);
    const hasta = resolveConfigBoundary(cfg, 'vigente_hasta_naked', 'vigente_hasta', sqlText);
    return desde <= refDate && (!hasta || hasta > refDate);
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const aDesde = resolveConfigBoundary(a, 'vigente_desde_naked', 'vigente_desde', sqlText) || new Date(0);
    const bDesde = resolveConfigBoundary(b, 'vigente_desde_naked', 'vigente_desde', sqlText) || new Date(0);
    return bDesde - aDesde;
  });
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
  lockCoordinator = null,
  // Fase 4 (compensacion FIFO en addSaldoPoints): por defecto la tabla NO
  // existe (mismo estado que un entorno donde la migracion 20260728 aun no
  // se aplico), para que TODAS las pruebas existentes de acumulacion sigan
  // comportandose exactamente igual sin declarar nada nuevo. Las pruebas
  // de compensacion la activan explicitamente con
  // ajustesPendientesTableExists: true y ajustesPendientes: [...].
  ajustesPendientesTableExists = false,
  ajustesPendientes = [],
  compensationCatalogsAvailable = true
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
    ajustesPendientesTableExists,
    ajustesPendientes: ajustesPendientes.map((row, index) => ({
      id_ajuste: index + 1,
      puntos_recuperados: 0,
      estado: 'PENDIENTE',
      fecha_creacion: index,
      ...row
    })),
    nextAjusteId: ajustesPendientes.length + 1,
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

  // Snapshot transaccional (BEGIN -> COMMIT/ROLLBACK), por-CLIENTE, no en
  // `state` compartido: dos conexiones que comparten `state` (sharedState,
  // pruebas de concurrencia LIVE/RECONCILE) no deben pisarse el snapshot
  // transaccional una a otra -cada una tiene su propia transaccion real-.
  // Sin esto, un ROLLBACK solo limpiaba `aborted`, dejando saldos,
  // movimientos e incrementos de intentos escritos DENTRO de la transaccion
  // fallida como si se hubieran confirmado -lo opuesto a PostgreSQL real-.
  let txSnapshot = null;

  const captureTxSnapshot = () => ({
    saldos: new Map(state.saldos),
    movimientos: [...state.movimientos],
    estadoFacturas: new Map(Array.from(state.estadoFacturas, ([id, row]) => [id, { ...row }])),
    nextMovimientoId: state.nextMovimientoId,
    escriturasPerfilMaestro: [...state.escriturasPerfilMaestro],
    telefonosUnicos: new Set(state.telefonosUnicos),
    telefonos: new Map(state.telefonos),
    nextTelefonoId: state.nextTelefonoId
  });

  const restoreTxSnapshot = (snapshot) => {
    state.saldos = snapshot.saldos;
    state.movimientos = snapshot.movimientos;
    state.estadoFacturas = snapshot.estadoFacturas;
    state.nextMovimientoId = snapshot.nextMovimientoId;
    state.escriturasPerfilMaestro = snapshot.escriturasPerfilMaestro;
    state.telefonosUnicos = snapshot.telefonosUnicos;
    state.telefonos = snapshot.telefonos;
    state.nextTelefonoId = snapshot.nextTelefonoId;
  };

  const getClienteProfile = (idCliente) => {
    const override = state.clienteProfiles[Number(idCliente)];
    return override === undefined ? state.defaultClienteProfile : override;
  };

  const parseIdLike = (value) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };

  // Replica COALESCE(f.id_cliente, p.id_cliente) de la consulta real: el
  // cliente de la FACTURA gana siempre que exista; el dueno del pedido
  // (state.pedidos[idPedido].id_cliente) es solo el fallback. Las pruebas
  // deben declarar facturaContexts[...].id_cliente (factura.id_cliente) y
  // state.pedidos[...].id_cliente (pedido.id_cliente) POR SEPARADO -nunca un
  // valor ya combinado- para que esta funcion ejercite de verdad la misma
  // precedencia que la consulta SQL real, en vez de ocultarla.
  const resolveClienteEfectivo = (context) => {
    const facturaIdCliente = parseIdLike(context?.id_cliente);
    if (facturaIdCliente) return facturaIdCliente;
    const idPedido = context?.id_pedido ?? null;
    const pedido = idPedido ? state.pedidos[Number(idPedido)] : null;
    return pedido ? parseIdLike(pedido.id_cliente) : null;
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
  const computeMissingAccumulationCandidates = (cursor, limit, graceMs = 0, sqlText = '') => {
    if (state.missingAccumulationIds !== null) {
      return state.missingAccumulationIds.filter((id) => id > cursor).slice(0, limit);
    }

    const graceCutoff = Date.now() - graceMs;
    const candidates = Object.entries(state.facturaContexts)
      .map(([idStr, context]) => ({ id: Number(idStr), context }))
      .filter(({ id, context }) => {
        if (id <= cursor) return false;
        // COALESCE(est.id_cliente, f.id_cliente, p.id_cliente): la evidencia
        // durable YA CONGELADA decide primero -una reserva PENDING con
        // snapshot puede ser candidata aunque el cliente ACTUAL de la
        // factura/pedido sea NULL hoy-; resolveClienteEfectivo (factura/
        // pedido) es solo el fallback para candidatos sin fila durable
        // todavia. Sin esto, el mock ocultaria el mismo bug que tenia la
        // consulta real (descartar un candidato con snapshot valido).
        const durableState = state.estadoFacturas.get(id);
        const effectiveCandidateClient = parseIdLike(durableState?.id_cliente) ?? resolveClienteEfectivo(context);
        if (!effectiveCandidateClient) return false;
        if (!isContextFullyPaid(context)) return false;
        if (hasMovimiento(id)) return false;
        if (!isRetryableOrNoState(id)) return false;
        // El periodo de gracia compara el MISMO instante canonico que la
        // consulta real (con su AT TIME ZONE), no el reloj de pared crudo.
        const refInstant = resolveFacturaReferenceInstant(context, sqlText);
        const refMs = refInstant ? new Date(refInstant).getTime() : NaN;
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
        // Captura el estado mutable para poder restaurarlo en un ROLLBACK
        // real (no de SAVEPOINT) mas abajo.
        txSnapshot = captureTxSnapshot();
        return { rows: [] };
      }
      if (trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
        if (trimmed === 'COMMIT' && state.aborted) {
          // PostgreSQL rechaza el COMMIT de una transaccion abortada.
          throw buildAbortedTransactionError();
        }
        if (trimmed === 'ROLLBACK' && txSnapshot) {
          // Deshace TODA escritura transaccional -saldos, movimientos,
          // estado durable (incluidos incrementos de intentos)- igual que
          // PostgreSQL: un ROLLBACK no es solo "dejar de estar abortada", es
          // reponer los datos al momento del BEGIN.
          restoreTxSnapshot(txSnapshot);
        }
        txSnapshot = null;
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
        // COALESCE(f.id_cliente, p.id_cliente): nunca el valor crudo de
        // context.id_cliente sin resolver contra el pedido.
        const idCliente = resolveClienteEfectivo(context);
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
            // Misma conversion de zona que aplicaria PostgreSQL sobre el SQL
            // real de fetchAccumulationSnapshotSources.
            fecha_referencia: resolveFacturaReferenceInstant(context, text),
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

        // ensurePendingAccumulationState se distingue por el literal
        // 'PENDING' NO parametrizado en su VALUES -unico a esta funcion,
        // upsertAccumulationState siempre pasa estado como $2-. (params:
        // [idFactura, fechaReferencia, idPedido, idCliente, idSucursal,
        // origenPedido, nombreSnapshot, telefonoSnapshot, perfilCompletoSnapshot]).
        if (text.includes("VALUES ($1, 'PENDING'")) {
          const existing = state.estadoFacturas.get(id);

          if (!existing) {
            const nextRow = {
              id_factura: id,
              estado: 'PENDING',
              motivo: null,
              elegibilidad_determinada: null,
              fecha_referencia: params[1] ?? null,
              intentos: 0,
              ultimo_error: null,
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

          // Mismo WHERE que el real: nunca toca un estado terminal.
          if (existing.estado !== 'PENDING' && existing.estado !== 'RETRYABLE_ERROR') {
            return { rows: [] };
          }

          // ON CONFLICT DO UPDATE ... COALESCE(existente, EXCLUDED): completa
          // columnas vacias sin pisar un snapshot ya grabado, y sin tocar
          // intentos/estado (completar el snapshot no es un intento).
          const nextRow = {
            ...existing,
            id_pedido: existing.id_pedido ?? params[2] ?? null,
            id_cliente: existing.id_cliente ?? params[3] ?? null,
            id_sucursal: existing.id_sucursal ?? params[4] ?? null,
            origen_pedido: existing.origen_pedido ?? params[5] ?? null,
            nombre_snapshot: existing.nombre_snapshot ?? params[6] ?? null,
            telefono_snapshot: existing.telefono_snapshot ?? params[7] ?? null,
            perfil_completo_snapshot: existing.perfil_completo_snapshot ?? params[8] ?? null,
            fecha_referencia: existing.fecha_referencia ?? params[1] ?? null
          };
          state.estadoFacturas.set(id, nextRow);
          return { rows: [nextRow] };
        }

        // upsertAccumulationState: DO UPDATE (params: [idFactura, estado,
        // motivo, elegibilidadDeterminada, fechaReferencia, ultimoError,
        // idPedido, idCliente, idSucursal, origenPedido, nombreSnapshot,
        // telefonoSnapshot, perfilCompletoSnapshot]). Las columnas de
        // snapshot al final son opcionales (recordAccumulationRetryableError
        // las pasa cuando ya se conocia el snapshot antes del rollback) y se
        // preservan con la misma semantica COALESCE.
        const [
          , estado, motivo, elegibilidadDeterminada, fechaReferencia, ultimoError,
          snapIdPedido, snapIdCliente, snapIdSucursal, snapOrigenPedido,
          snapNombreSnapshot, snapTelefonoSnapshot, snapPerfilCompletoSnapshot
        ] = params;
        const existing = state.estadoFacturas.get(id);

        // Mismo guard que el WHERE del ON CONFLICT DO UPDATE real: nunca
        // degrada un estado terminal ya grabado.
        if (existing && existing.estado !== 'PENDING' && existing.estado !== 'RETRYABLE_ERROR') {
          return { rows: [existing] };
        }

        const nextRow = {
          id_pedido: existing?.id_pedido ?? snapIdPedido ?? null,
          id_cliente: existing?.id_cliente ?? snapIdCliente ?? null,
          id_sucursal: existing?.id_sucursal ?? snapIdSucursal ?? null,
          origen_pedido: existing?.origen_pedido ?? snapOrigenPedido ?? null,
          nombre_snapshot: existing?.nombre_snapshot ?? snapNombreSnapshot ?? null,
          telefono_snapshot: existing?.telefono_snapshot ?? snapTelefonoSnapshot ?? null,
          perfil_completo_snapshot: existing?.perfil_completo_snapshot ?? snapPerfilCompletoSnapshot ?? null,
          id_factura: id,
          estado,
          motivo: motivo ?? null,
          elegibilidad_determinada: elegibilidadDeterminada ?? null,
          // COALESCE(existente, EXCLUDED) igual que el SQL real: una fecha
          // durable ya confirmada NUNCA se reemplaza por la que llegue en
          // este upsert (ronda 6: este orden estaba invertido -favorecia el
          // valor nuevo sobre el existente-, escondiendo que una fecha ya
          // grabada podia sobrescribirse).
          fecha_referencia: existing?.fecha_referencia ?? fechaReferencia ?? null,
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
        const ids = computeMissingAccumulationCandidates(cursor, limit, graceMs, text);
        return { rows: ids.map((id) => ({ id_factura: id })) };
      }

      if (text.includes('FROM public.facturas f')) {
        const facturaId = Number(params[0]);
        const context = state.facturaContexts[facturaId];
        if (!context) return { rows: [] };
        // COALESCE(f.id_cliente, p.id_cliente): id_sucursal/id_usuario del
        // context se dejan tal cual (esos usan COALESCE(pedido, factura), no
        // forman parte de este bug); solo id_cliente se resuelve aqui.
        return {
          rows: [{
            id_factura: facturaId,
            ...context,
            id_cliente: resolveClienteEfectivo(context),
            // Misma conversion de zona que aplicaria PostgreSQL sobre el SQL
            // real de getFacturaAccumulationContext.
            fecha_referencia_config: resolveFacturaReferenceInstant(context, text)
          }]
        };
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
        // Se pasa el SQL real: la zona con la que se interpretan
        // vigente_desde/vigente_hasta sale de la propia consulta.
        const match = resolveConfigForDate(state.activeConfigs, params[1], text);
        return { rows: match ? [match] : [] };
      }

      if (text.includes('cat_fidelizacion_tipos_movimiento') && text.includes('SELECT')) {
        const code = String(params[0] || '').toUpperCase();
        if (code === 'COMPENSACION' && !compensationCatalogsAvailable) return { rows: [] };
        const id = CATALOG_IDS.tipos[code];
        return { rows: id ? [{ id_catalogo: id, codigo: code, nombre: code, estado: true }] : [] };
      }

      if (text.includes('cat_fidelizacion_origenes_movimiento') && text.includes('SELECT')) {
        const code = String(params[0] || '').toUpperCase();
        if (code === 'AJUSTE_PENDIENTE' && !compensationCatalogsAvailable) return { rows: [] };
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
          tipo: Number(params[2]) === CATALOG_IDS.tipos.COMPENSACION ? 'COMPENSACION' : 'ACUMULACION',
          origen: Number(params[6]) === CATALOG_IDS.origenes.AJUSTE_PENDIENTE ? 'AJUSTE_PENDIENTE' : 'FACTURA',
          puntos_delta: Number(params[3]),
          saldo_anterior: Number(params[4]),
          saldo_nuevo: Number(params[5])
        });
        return { rows: [{ id_movimiento: idMovimiento }] };
      }

      // Fase 4: sonda de esquema (hasTable) para
      // fidelizacion_ajustes_pendientes -- SELECT to_regclass($1) AS reg.
      // Por defecto ausente (ver ajustesPendientesTableExists arriba).
      if (text.includes('SELECT to_regclass(')) {
        const tableParam = String(params?.[0] || '');
        if (tableParam.includes('fidelizacion_ajustes_pendientes')) {
          return { rows: [{ reg: state.ajustesPendientesTableExists ? 'fidelizacion_ajustes_pendientes' : null }] };
        }
        return { rows: [{ reg: null }] };
      }

      // Fase 4: bloqueo FIFO de ajustes pendientes de un cliente (compensacion
      // en addSaldoPoints) -- ORDER BY fecha_creacion ASC, id_ajuste ASC.
      if (text.includes('FROM public.fidelizacion_ajustes_pendientes') && text.includes('FOR UPDATE')) {
        const idCliente = Number(params[0]);
        const rows = state.ajustesPendientes
          .filter((a) => a.id_cliente === idCliente && (a.estado === 'PENDIENTE' || a.estado === 'PARCIALMENTE_RECUPERADO'))
          .sort((a, b) => (a.fecha_creacion - b.fecha_creacion) || (a.id_ajuste - b.id_ajuste));
        return { rows: rows.map((row) => ({ ...row })) };
      }

      if (text.includes('UPDATE public.fidelizacion_ajustes_pendientes')) {
        const [puntosRecuperados, puntosPendientes, estado, idAjuste] = params;
        const row = state.ajustesPendientes.find((a) => a.id_ajuste === Number(idAjuste));
        if (row) {
          row.puntos_recuperados = Number(puntosRecuperados);
          row.puntos_pendientes = Number(puntosPendientes);
          row.estado = estado;
        }
        return { rows: [] };
      }

      if (text.includes('INSERT INTO public.fidelizacion_ajustes_pendientes')) {
        const [idCliente, idFactura, idReversion, puntosObjetivo, puntosRecuperados, puntosPendientes, estado, idUsuarioEjecutor] = params;
        if (state.ajustesPendientes.some((a) => a.id_reversion === Number(idReversion))) {
          return { rows: [] };
        }
        const idAjuste = state.nextAjusteId++;
        state.ajustesPendientes.push({
          id_ajuste: idAjuste,
          id_cliente: Number(idCliente),
          id_factura: Number(idFactura),
          id_reversion: Number(idReversion),
          puntos_objetivo: Number(puntosObjetivo),
          puntos_recuperados: Number(puntosRecuperados),
          puntos_pendientes: Number(puntosPendientes),
          estado,
          id_usuario_ejecutor: idUsuarioEjecutor,
          fecha_creacion: state.ajustesPendientes.length
        });
        return { rows: [{ id_ajuste: idAjuste }] };
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
