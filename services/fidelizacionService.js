import pool from '../config/db-connection.js';
import { getClientIp } from '../utils/security/clientInfo.js';
import { normalizePhoneHN } from '../utils/security/personasHardening.js';
import { computeAccumulationPoints } from '../modules/fidelizacion/domain/pointsCalculator.js';

const TEGUCIGALPA_TIMEZONE = 'America/Tegucigalpa';

const hasBitacorasCache = {
  loaded: false,
  value: false
};

// Mismo nombre de columna que routers/clientes.js (CLIENTE_EMPRESA_RELATION_FIELD):
// algunos entornos ya tienen clientes.id_empresa_cliente, otros todavia
// resuelven la relacion cliente->empresa via clientes.id_empresa. Se detecta
// una sola vez (cache de proceso) para no asumir un esquema fijo.
const CLIENTE_EMPRESA_RELATION_FIELD = 'id_empresa_cliente';
const clienteEmpresaRelationCache = {
  loaded: false,
  hasField: false
};

const loadHasClienteEmpresaRelationField = async (queryRunner = pool) => {
  if (!clienteEmpresaRelationCache.loaded) {
    const result = await queryRunner.query(
      `
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'clientes' AND column_name = $1
        LIMIT 1
      `,
      [CLIENTE_EMPRESA_RELATION_FIELD]
    );
    clienteEmpresaRelationCache.loaded = true;
    clienteEmpresaRelationCache.hasField = result.rowCount > 0;
  }

  return clienteEmpresaRelationCache.hasField;
};

// Fragmento SQL (no parametrizado: solo puede valer uno de dos literales
// internos, nunca datos de entrada) para resolver el id_empresa real de un
// cliente tipo empresa, igual que empresaRelationExpr en routers/clientes.js.
export const buildClienteEmpresaRelationSql = async (client, alias = 'c') => {
  const hasField = await loadHasClienteEmpresaRelationField(client);
  return hasField
    ? `COALESCE(${alias}.${CLIENTE_EMPRESA_RELATION_FIELD}, CASE WHEN ${alias}.id_persona IS NULL THEN ${alias}.id_empresa ELSE NULL END)`
    : `${alias}.id_empresa`;
};

const normalizeText = (value) => String(value ?? '').trim();

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// parsePositiveInt (arriba) usa Number.parseInt, que trunca y se detiene en
// el primer caracter no numerico: "156abc" -> 156, "1.5" -> 1, "2 OR 1=1" -> 2.
// Eso no es una brecha de SQL injection (todo sigue parametrizado), pero es
// un problema de integridad: una entrada invalida se convierte en silencio
// en una operacion valida distinta (otro id_producto, otra cantidad). Este
// parser estricto exige que TODO el valor sea un entero positivo puro antes
// de aceptarlo -- usado para id_cliente, id_sucursal, id_producto, cantidad
// y puntos_requeridos_override en el flujo de canje (bloqueante de
// integridad de la auditoria independiente). No reemplaza parsePositiveInt
// globalmente (evita auditar/romper sus otros usos existentes en este
// archivo); es un helper nuevo y separado.
const parseStrictPositiveInt = (value) => {
  // Rechaza arreglos y objetos explicitamente: String(['1']) === '1' pasaria
  // el regex de abajo si no se filtra el tipo primero (p.ej. id_producto[]=1).
  if (value !== null && typeof value === 'object') return null;

  // Number.isSafeInteger (no solo Number.isInteger) en AMBAS ramas: un
  // number que ya perdio precision en JS (p.ej. Number.MAX_SAFE_INTEGER + 1,
  // que sigue siendo "entero" segun Number.isInteger pero ya no representa
  // un valor exacto) tampoco debe aceptarse como id/cantidad valido.
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseNonNegativeInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const parsePositiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

// lempiras_por_punto tambien se usa para calcular canjes, asi que debe seguir
// siendo > 0 en TODA configuracion guardada, independiente del switch de
// acumulacion. Reglas:
// - Si el payload trae el campo (inputProvided=true) pero no es un numero
//   valido > 0 (0, negativo, NaN, no numerico), es invalido: nunca se cae de
//   forma silenciosa a la tasa anterior.
// - Si el payload omite el campo, se conserva la tasa anterior (siempre que
//   sea > 0); si no hay configuracion previa, tambien es invalido (no hay
//   tasa valida que conservar para la primera configuracion de la sucursal).
const resolveEffectiveLempirasPorPunto = ({ inputProvided, inputValue, previousConfig }) => {
  if (inputProvided) {
    return inputValue ? { ok: true, value: inputValue } : { ok: false };
  }

  const previousValue = Number(previousConfig?.lempiras_por_punto);
  if (Number.isFinite(previousValue) && previousValue > 0) {
    return { ok: true, value: previousValue };
  }

  return { ok: false };
};

// Decide si guardar una configuracion exige que el usuario confirme
// explicitamente la equivalencia de la tasa (confirmar_equivalencia).
//
// Contexto del defecto: lempiras_por_punto significa "cuantos lempiras hacen
// falta para ganar 1 punto" (puntos = floor(total / tasa)). Un usuario lo
// interpreto al reves y guardo 0.01, con lo que una compra de L 1,130.00
// acumulo 113,000 puntos. La formula era correcta; lo ambiguo era el campo.
// Por eso se exige una confirmacion explicita cuando la tasa se establece por
// primera vez o cambia de valor.
//
// La comparacion es NUMERICA, no textual: la columna es numeric y el driver
// de PostgreSQL puede devolverla como string, asi que 100, "100" y "100.00"
// son exactamente la misma tasa y NO deben volver a pedir confirmacion (un
// guardado que solo toca productos canjeables o el switch no debe convertirse
// en una confirmacion innecesaria). Se centraliza aqui para que exista una
// sola definicion de "la tasa cambio".
export const isSameLempirasPorPuntoRate = (a, b) => {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return left === right;
};

// requiresRateConfirmation: true cuando no hay configuracion previa (primera
// tasa de la sucursal) o cuando la tasa efectiva difiere de la vigente.
export const requiresRateConfirmation = ({ previousConfig, nextLempirasPorPunto }) => {
  if (!previousConfig) return true;
  return !isSameLempirasPorPuntoRate(previousConfig.lempiras_por_punto, nextLempirasPorPunto);
};

// Confirmacion estrictamente booleana: "true", 1, "1", {} y [] NO valen. Un
// cliente que no sea la interfaz oficial no debe poder saltarse la
// confirmacion enviando un valor "parecido a verdadero".
export const isExplicitRateConfirmation = (value) => value === true;

// Compatibilidad con payloads antiguos: si el switch se omite y ya existe
// configuracion previa, se conserva su valor (nunca se apaga en silencio);
// solo se usa false cuando de verdad es la primera configuracion.
const resolveEffectiveAcumulacionHabilitada = ({ inputProvided, inputValue, previousConfig }) => {
  if (inputProvided) return Boolean(inputValue);
  if (previousConfig) return Boolean(previousConfig.acumulacion_habilitada);
  return false;
};

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

export const createFidelizacionError = (status, code, publicMessage, internalMessage = null) => {
  const error = new Error(internalMessage || publicMessage || 'Fidelizacion error');
  error.httpStatus = status;
  error.code = code;
  error.publicMessage = publicMessage;
  return error;
};

const loadHasBitacoras = async (queryRunner = pool) => {
  if (!hasBitacorasCache.loaded) {
    const result = await queryRunner.query(`SELECT to_regclass('public.bitacoras') AS reg`);
    hasBitacorasCache.loaded = true;
    hasBitacorasCache.value = Boolean(result.rows?.[0]?.reg);
  }

  return hasBitacorasCache.value;
};

export const insertFidelizacionAuditLog = async ({
  client,
  req,
  idUsuario,
  accion,
  descripcion,
  idRegistro = null,
  datosAntes = null,
  datosDespues = null
}) => {
  const actorId = parsePositiveInt(idUsuario);
  if (!actorId) return;

  const hasBitacoras = await loadHasBitacoras(client);
  if (!hasBitacoras) return;

  await client.query(
    `
      INSERT INTO public.bitacoras (
        accion,
        descripcion,
        fecha_hora,
        id_usuario,
        modulo,
        tabla_afectada,
        id_registro,
        ip_origen,
        datos_antes,
        datos_despues
      )
      VALUES (
        $1,
        $2,
        timezone('${TEGUCIGALPA_TIMEZONE}', now()),
        $3,
        'FIDELIZACION',
        'FIDELIZACION',
        $4,
        $5,
        $6::jsonb,
        $7::jsonb
      )
    `,
    [
      normalizeText(accion).slice(0, 50) || 'FIDELIZACION_ACCION',
      normalizeText(descripcion).slice(0, 100) || 'Accion de fidelizacion',
      actorId,
      parsePositiveInt(idRegistro) || 0,
      normalizeText(getClientIp(req) || '-').slice(0, 60) || '-',
      datosAntes ? JSON.stringify(datosAntes) : JSON.stringify({}),
      datosDespues ? JSON.stringify(datosDespues) : JSON.stringify({})
    ]
  );
};

const getCatalogRowByCode = async (client, tableName, idField, code) => {
  const result = await client.query(
    `
      SELECT ${idField} AS id_catalogo, codigo, nombre, estado
      FROM public.${tableName}
      WHERE UPPER(TRIM(codigo)) = UPPER(TRIM($1))
      LIMIT 1
    `,
    [code]
  );

  return result.rows[0] || null;
};

const resolveFidelizacionCatalogs = async (client) => {
  const [tipoAcumulacion, tipoCanje, origenFactura, origenCanje, estadoRegistrado] = await Promise.all([
    getCatalogRowByCode(client, 'cat_fidelizacion_tipos_movimiento', 'id_tipo_movimiento', 'ACUMULACION'),
    getCatalogRowByCode(client, 'cat_fidelizacion_tipos_movimiento', 'id_tipo_movimiento', 'CANJE'),
    getCatalogRowByCode(client, 'cat_fidelizacion_origenes_movimiento', 'id_origen_movimiento', 'FACTURA'),
    getCatalogRowByCode(client, 'cat_fidelizacion_origenes_movimiento', 'id_origen_movimiento', 'CANJE'),
    getCatalogRowByCode(client, 'cat_fidelizacion_estados_canje', 'id_estado_canje', 'REGISTRADO')
  ]);

  const requiredRows = [
    ['tipo acumulacion', tipoAcumulacion],
    ['tipo canje', tipoCanje],
    ['origen factura', origenFactura],
    ['origen canje', origenCanje],
    ['estado registrado', estadoRegistrado]
  ];

  const missing = requiredRows.find(([, row]) => !row || row.estado === false);
  if (missing) {
    throw createFidelizacionError(
      500,
      'FIDELIZACION_CATALOGS_ERROR',
      'No se pudo procesar la solicitud de fidelizacion.'
    );
  }

  return {
    tipoAcumulacionId: Number(tipoAcumulacion.id_catalogo),
    tipoCanjeId: Number(tipoCanje.id_catalogo),
    origenFacturaId: Number(origenFactura.id_catalogo),
    origenCanjeId: Number(origenCanje.id_catalogo),
    estadoRegistradoId: Number(estadoRegistrado.id_catalogo)
  };
};

// referenceDate es opcional.
// - referenceDate null (canje presencial, configuracion administrativa):
//   busca la configuracion ACTUAL, exige estado=true y vigencia HOY.
// - referenceDate presente (acumulacion por factura pagada): busca la
//   configuracion cuya ventana de vigencia incluia esa fecha, SIN exigir
//   estado=true, porque una configuracion historica puede haber sido
//   desactivada despues sin que eso deba reescribir lo que aplico en su
//   momento a una factura ya pagada.
export const getActiveFidelizacionConfig = async (client, idSucursal, referenceDate = null) => {
  const sucursalId = parsePositiveInt(idSucursal);
  if (!sucursalId) return null;

  const result = await client.query(
    `
      SELECT
        fcs.id_configuracion,
        fcs.id_sucursal,
        fcs.lempiras_por_punto,
        fcs.acumulacion_habilitada,
        fcs.vigente_desde,
        fcs.vigente_hasta,
        fcs.estado,
        fcs.id_usuario_creador,
        fcs.fecha_creacion,
        fcs.fecha_actualizacion
      FROM public.fidelizacion_configuracion_sucursal fcs
      WHERE fcs.id_sucursal = $1
        AND ($2::timestamptz IS NOT NULL OR COALESCE(fcs.estado, true) = true)
        -- vigente_desde/vigente_hasta son 'timestamp without time zone' que
        -- guardan HORA UTC: se escriben con NOW() a secas (ver saveConfiguracion
        -- en routers/fidelizacion.js) y PostgreSQL castea timestamptz ->
        -- timestamp con el TimeZone de la sesion, que es UTC. Se declara esa
        -- zona explicitamente (AT TIME ZONE 'UTC' -> timestamptz) en vez de
        -- confiar en el cast implicito: asi la comparacion es siempre entre
        -- instantes reales equivalentes y deja de depender del TimeZone de la
        -- sesion/servidor. La fecha de referencia ($2) ya llega como instante
        -- absoluto desde el punto canonico de conversion
        -- (FACTURA_REFERENCE_INSTANT_SQL en modules/fidelizacion/infrastructure/
        -- fidelizacionRepository.js), asi que aqui NO se vuelve a convertir.
        -- Semantica de vigencia intacta: vigente_desde inclusivo (<=),
        -- vigente_hasta exclusivo (>).
        AND (fcs.vigente_desde AT TIME ZONE 'UTC') <= COALESCE($2::timestamptz, NOW())
        AND (
          fcs.vigente_hasta IS NULL
          OR (fcs.vigente_hasta AT TIME ZONE 'UTC') > COALESCE($2::timestamptz, NOW())
        )
      ORDER BY fcs.vigente_desde DESC, fcs.id_configuracion DESC
      LIMIT 1
    `,
    [sucursalId, referenceDate || null]
  );

  return result.rows[0] || null;
};

const ensureSaldoRow = async (client, idCliente) => {
  const clienteId = parsePositiveInt(idCliente);
  if (!clienteId) {
    throw createFidelizacionError(
      400,
      'FIDELIZACION_CLIENTE_INVALIDO',
      'El cliente seleccionado no es valido.'
    );
  }

  await client.query(
    `
      INSERT INTO public.fidelizacion_saldos_cliente (
        id_cliente,
        puntos_disponibles,
        puntos_acumulados_total,
        puntos_canjeados_total,
        fecha_creacion,
        fecha_actualizacion
      )
      VALUES ($1, 0, 0, 0, NOW(), NOW())
      ON CONFLICT (id_cliente) DO NOTHING
    `,
    [clienteId]
  );
};

export const getClienteSaldoForUpdate = async (client, idCliente) => {
  await ensureSaldoRow(client, idCliente);

  const result = await client.query(
    `
      SELECT
        id_cliente,
        puntos_disponibles,
        puntos_acumulados_total,
        puntos_canjeados_total,
        fecha_creacion,
        fecha_actualizacion
      FROM public.fidelizacion_saldos_cliente
      WHERE id_cliente = $1
      FOR UPDATE
    `,
    [idCliente]
  );

  return result.rows[0] || null;
};

const syncLegacyClientePoints = async (client, idCliente, puntosDisponibles) => {
  await client.query(
    `
      UPDATE public.clientes
      SET puntos = $1
      WHERE id_cliente = $2
    `,
    [parseNonNegativeInt(puntosDisponibles) || 0, idCliente]
  );
};

// Elegibilidad por PERFIL del cliente (no por usuario/rol): activo, con
// nombre valido (persona.nombre o empresa.nombre_empresa segun el tipo de
// cliente) y con un telefono asociado mediante la relacion real del modelo
// actual (personas/empresas -> telefonos). No exige apellido, correo, ni que
// el cliente tenga usuario o rol CLIENTE.
export const fetchClienteProfileForFidelizacion = async (client, idCliente) => {
  const clienteId = parsePositiveInt(idCliente);
  if (!clienteId) return null;

  const empresaRelationExpr = await buildClienteEmpresaRelationSql(client, 'c');

  const result = await client.query(
    `
      SELECT
        c.id_cliente,
        COALESCE(c.estado, true) AS estado,
        CASE WHEN c.id_persona IS NOT NULL THEN p.nombre ELSE e.nombre_empresa END AS nombre,
        CASE WHEN c.id_persona IS NOT NULL THEN telf_p.telefono ELSE telf_e.telefono END AS telefono
      FROM public.clientes c
      LEFT JOIN public.personas p ON p.id_persona = c.id_persona
      LEFT JOIN public.telefonos telf_p ON telf_p.id_telefono = p.id_telefono
      LEFT JOIN public.empresas e ON e.id_empresa = ${empresaRelationExpr}
      LEFT JOIN public.telefonos telf_e ON telf_e.id_telefono = e.id_telefono
      WHERE c.id_cliente = $1
      LIMIT 1
    `,
    [clienteId]
  );

  return result.rows[0] || null;
};

// normalizePhoneHN es la funcion canonica de normalizacion de telefono ya
// existente en el proyecto (utils/security/personasHardening.js), reutilizada
// aqui tal cual. Nombre valido = no vacio tras trim; no se exige formato de
// nombre (eso ya lo valida el alta de personas/empresas, no fidelizacion).
export const isClienteProfileComplete = (profile) => {
  if (!profile) return false;
  const nombreValido = normalizeText(profile.nombre).length > 0;
  const telefonoValido = Boolean(normalizePhoneHN(profile.telefono));
  return Boolean(profile.estado) && nombreValido && telefonoValido;
};

// Fase 4 (seccion 3.6): sonda de esquema para fidelizacion_ajustes_pendientes,
// consistente con el patron hasColumn/hasTable ya usado en Fase 3
// (routers/cocina.js, routers/ventas/services/ventasReversionInventoryService.js).
// Cacheada por proceso: la tabla no aparece/desaparece en caliente durante
// la vida de un mismo proceso Node.
let ajustesPendientesTableExistsCache = null;
const hasFidelizacionAjustesPendientesTable = async (client) => {
  if (ajustesPendientesTableExistsCache !== null) return ajustesPendientesTableExistsCache;
  const result = await client.query('SELECT to_regclass($1) AS reg', ['public.fidelizacion_ajustes_pendientes']);
  ajustesPendientesTableExistsCache = Boolean(result.rows?.[0]?.reg);
  return ajustesPendientesTableExistsCache;
};

// Catalogos obligatorios de compensacion
// (COMPENSACION/AJUSTE_PENDIENTE). Se leen sin LIMIT para detectar
// configuraciones ambiguas por codigo normalizado.
const resolveCompensationCatalogs = async (client) => {
  const [types, origins] = await Promise.all([
    client.query(
      `
        SELECT id_tipo_movimiento AS id_catalogo, estado
        FROM public.cat_fidelizacion_tipos_movimiento
        WHERE UPPER(TRIM(codigo)) = UPPER(TRIM($1))
        ORDER BY id_tipo_movimiento
        FOR SHARE
      `,
      ['COMPENSACION']
    ),
    client.query(
      `
        SELECT id_origen_movimiento AS id_catalogo, estado
        FROM public.cat_fidelizacion_origenes_movimiento
        WHERE UPPER(TRIM(codigo)) = UPPER(TRIM($1))
        ORDER BY id_origen_movimiento
        FOR SHARE
      `,
      ['AJUSTE_PENDIENTE']
    )
  ]);
  const type = types.rows?.[0];
  const origin = origins.rows?.[0];
  if (
    types.rows?.length !== 1
    || origins.rows?.length !== 1
    || type?.estado === false
    || origin?.estado === false
  ) {
    throw createFidelizacionError(
      409,
      'FIDELIZACION_SCHEMA_PENDIENTE',
      'Los catalogos de compensacion de fidelizacion no estan configurados de forma unica y activa.'
    );
  }
  return {
    tipoCompensacionId: Number(type.id_catalogo),
    origenAjustePendienteId: Number(origin.id_catalogo)
  };
};

/**
 * Compensacion FIFO (seccion 3.6 del ticket): antes de que una acumulacion
 * aumente puntos_disponibles, se bloquean (FOR UPDATE) los ajustes
 * pendientes del cliente en orden fecha_creacion ASC, id_ajuste ASC, y los
 * puntos nuevos se aplican primero a la deuda mas antigua. Solo el
 * remanente (si sobra algo despues de saldar toda la deuda) aumenta el
 * saldo disponible real.
 */
const applyFifoCompensation = async ({ client, idCliente, puntosDisponiblesParaCompensar }) => {
  let remaining = Number(puntosDisponiblesParaCompensar || 0);
  if (remaining <= 0) return { compensado: 0, ajustesTocados: [] };

  const result = await client.query(
    `
      SELECT id_ajuste, puntos_recuperados, puntos_pendientes, estado
      FROM public.fidelizacion_ajustes_pendientes
      WHERE id_cliente = $1
        AND estado IN ('PENDIENTE', 'PARCIALMENTE_RECUPERADO')
      ORDER BY fecha_creacion ASC, id_ajuste ASC
      FOR UPDATE
    `,
    [idCliente]
  );

  const ajustesTocados = [];
  const hasCompensableDebt = result.rows.some((row) => Number(row.puntos_pendientes || 0) > 0);
  const catalogs = hasCompensableDebt ? await resolveCompensationCatalogs(client) : null;
  for (const ajuste of result.rows) {
    if (remaining <= 0) break;
    const pendienteActual = Number(ajuste.puntos_pendientes || 0);
    if (pendienteActual <= 0) continue;

    const compensar = Math.min(remaining, pendienteActual);
    if (compensar <= 0) continue;

    const nuevoRecuperados = Number(ajuste.puntos_recuperados || 0) + compensar;
    const nuevoPendientes = pendienteActual - compensar;
    const nuevoEstado = nuevoPendientes === 0 ? 'RECUPERADO' : 'PARCIALMENTE_RECUPERADO';

    await client.query(
      `
        UPDATE public.fidelizacion_ajustes_pendientes
        SET puntos_recuperados = $1, puntos_pendientes = $2, estado = $3, fecha_actualizacion = NOW()
        WHERE id_ajuste = $4
      `,
      [nuevoRecuperados, nuevoPendientes, nuevoEstado, Number(ajuste.id_ajuste)]
    );

    remaining -= compensar;
    ajustesTocados.push({ id_ajuste: Number(ajuste.id_ajuste), compensado: compensar });
  }

  const compensado = ajustesTocados.reduce((sum, entry) => sum + entry.compensado, 0);
  return { compensado, ajustesTocados, catalogs };
};

const registerFidelizacionMovement = async (client, payload) => {
  const result = await client.query(
    `
      INSERT INTO public.fidelizacion_movimientos (
        id_cliente,
        id_sucursal,
        id_tipo_movimiento,
        puntos_delta,
        saldo_anterior,
        saldo_nuevo,
        id_origen_movimiento,
        id_factura,
        id_pedido,
        id_canje,
        observacion,
        id_usuario_ejecutor,
        fecha_creacion
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        NOW()
      )
      RETURNING id_movimiento
    `,
    [
      payload.id_cliente,
      payload.id_sucursal,
      payload.id_tipo_movimiento,
      payload.puntos_delta,
      payload.saldo_anterior,
      payload.saldo_nuevo,
      payload.id_origen_movimiento,
      payload.id_factura || null,
      payload.id_pedido || null,
      payload.id_canje || null,
      payload.observacion || null,
      payload.id_usuario_ejecutor || null
    ]
  );

  return Number(result.rows?.[0]?.id_movimiento || 0);
};

const addSaldoPoints = async ({
  client,
  idCliente,
  puntosDelta,
  movementIds,
  idSucursal,
  idFactura = null,
  idPedido = null,
  idCanje = null,
  observacion = null,
  idUsuarioEjecutor = null
}) => {
  const saldo = await getClienteSaldoForUpdate(client, idCliente);
  if (!saldo) {
    throw createFidelizacionError(
      404,
      'FIDELIZACION_SALDO_NOT_FOUND',
      'No se encontro el saldo del cliente.'
    );
  }

  const saldoAnterior = Number(saldo.puntos_disponibles || 0);
  const acumuladosActuales = Number(saldo.puntos_acumulados_total || 0);
  const canjeadosActuales = Number(saldo.puntos_canjeados_total || 0);
  const isAccumulation = Number(puntosDelta || 0) > 0;

  // Fase 4 (seccion 3.6): compensacion FIFO. SOLO se aplica sobre
  // acumulaciones (puntosDelta > 0), nunca sobre canjes -- un canje ya
  // exige saldo disponible suficiente y no debe verse afectado por deuda
  // de una reversion anterior. Si fidelizacion_ajustes_pendientes no
  // existe todavia (migracion no aplicada), se omite por completo y el
  // comportamiento es identico al anterior a Fase 4.
  let compensacion = { compensado: 0, ajustesTocados: [], catalogs: null };
  if (isAccumulation && (await hasFidelizacionAjustesPendientesTable(client))) {
    compensacion = await applyFifoCompensation({
      client,
      idCliente,
      puntosDisponiblesParaCompensar: Number(puntosDelta)
    });
  }

  // saldoIntermedio: saldo conceptual tras la acumulacion/canje ANTES de
  // aplicar la compensacion (saldo_nuevo del movimiento principal).
  // nextSaldo: saldo REAL final, unica escritura real a
  // fidelizacion_saldos_cliente. Cuando compensacion.compensado===0 (todo
  // canje, y toda acumulacion sin deuda pendiente) ambos coinciden y el
  // comportamiento es exactamente el mismo que antes de Fase 4.
  const saldoIntermedio = saldoAnterior + Number(puntosDelta || 0);
  const nextSaldo = saldoIntermedio - compensacion.compensado;

  if (nextSaldo < 0) {
    throw createFidelizacionError(
      409,
      'FIDELIZACION_SALDO_INSUFICIENTE',
      'El cliente no tiene puntos suficientes para completar el canje.'
    );
  }

  // puntos_acumulados_total: significado HISTORICO ("total ganado alguna
  // vez"), nunca reducido por compensar una deuda -- el cliente si gano
  // estos puntos; la deuda es de una reversion PREVIA, ya reflejada en su
  // propio momento (ver applyLoyaltyReversalForFactura). Por eso usa el
  // delta COMPLETO (Number(puntosDelta)), no el remanente tras compensar.
  const accumulatedDelta = isAccumulation ? Number(puntosDelta) : 0;
  const redeemedDelta = !isAccumulation ? Math.abs(Number(puntosDelta)) : 0;

  await client.query(
    `
      UPDATE public.fidelizacion_saldos_cliente
      SET
        puntos_disponibles = $1,
        puntos_acumulados_total = $2,
        puntos_canjeados_total = $3,
        fecha_actualizacion = NOW()
      WHERE id_cliente = $4
    `,
    [
      nextSaldo,
      acumuladosActuales + accumulatedDelta,
      canjeadosActuales + redeemedDelta,
      idCliente
    ]
  );

  await syncLegacyClientePoints(client, idCliente, nextSaldo);

  const movementId = await registerFidelizacionMovement(client, {
    id_cliente: idCliente,
    id_sucursal: idSucursal,
    id_tipo_movimiento: movementIds.idTipoMovimiento,
    puntos_delta: Number(puntosDelta),
    saldo_anterior: saldoAnterior,
    saldo_nuevo: saldoIntermedio,
    id_origen_movimiento: movementIds.idOrigenMovimiento,
    id_factura: idFactura,
    id_pedido: idPedido,
    id_canje: idCanje,
    observacion: compensacion.compensado > 0
      ? `${observacion || ''} (Compensacion FIFO: ${compensacion.compensado} pts aplicados a ajuste(s) pendiente(s) #${compensacion.ajustesTocados.map((t) => t.id_ajuste).join(', #')}.)`.trim()
      : observacion,
    id_usuario_ejecutor: idUsuarioEjecutor
  });

  let idMovimientoCompensacion = null;
  if (compensacion.compensado > 0) {
    idMovimientoCompensacion = await registerFidelizacionMovement(client, {
      id_cliente: idCliente,
      id_sucursal: idSucursal,
      id_tipo_movimiento: compensacion.catalogs.tipoCompensacionId,
      puntos_delta: compensacion.compensado * -1,
      saldo_anterior: saldoIntermedio,
      saldo_nuevo: nextSaldo,
      id_origen_movimiento: compensacion.catalogs.origenAjustePendienteId,
      id_factura: idFactura,
      id_pedido: idPedido,
      id_canje: idCanje,
      observacion: `Compensacion FIFO de ${compensacion.compensado} pts contra ajuste(s) pendiente(s) #${compensacion.ajustesTocados.map((t) => t.id_ajuste).join(', #')}.`,
      id_usuario_ejecutor: idUsuarioEjecutor
    });
  }

  return {
    idMovimiento: movementId,
    saldoAnterior,
    saldoNuevo: nextSaldo,
    puntosCompensados: compensacion.compensado,
    idMovimientoCompensacion
  };
};

const buildVentaNumero = (idFactura) => `VTA-${String(idFactura).padStart(5, '0')}`;
const buildCanjeNumero = (idCanje) => `CAN-${String(idCanje).padStart(5, '0')}`;

const computeRedemptionPoints = (precioProducto, lempirasPorPunto) => {
  const price = Number(precioProducto || 0);
  const ratio = Number(lempirasPorPunto || 0);
  if (!Number.isFinite(price) || !Number.isFinite(ratio) || price <= 0 || ratio <= 0) return null;
  return Math.ceil(price / ratio);
};

// eligibilitySnapshot (opcional): evidencia historica capturada al momento
// del pago (ver modules/fidelizacion/application/reservePaidInvoiceAccumulation.js).
// Cuando viene, la elegibilidad sale de ahi y NO se consulta el perfil actual
// del cliente -es lo que impide que completar el perfil despues otorgue
// puntos retroactivos, y lo que permite acumular a un cliente del menu
// publico cuyo telefono solo existe en pedidos_contacto-.
// Cuando no viene, se conserva el comportamiento historico (consultar el
// perfil vigente), que es el correcto para llamadas directas y para las
// pruebas que ejercitan esta funcion de forma aislada.
export const registerFacturaLoyaltyAccumulation = async ({
  client,
  idFactura,
  idPedido = null,
  idCliente = null,
  idSucursal = null,
  idUsuarioEjecutor = null,
  montoFactura = 0,
  referenceDate = null,
  eligibilitySnapshot = null
}) => {
  const facturaId = parsePositiveInt(idFactura);
  const clienteId = parsePositiveInt(idCliente);
  const sucursalId = parsePositiveInt(idSucursal);

  if (!facturaId || !clienteId || !sucursalId) {
    return { created: false, reason: 'MISSING_REQUIRED_DATA' };
  }

  const existingResult = await client.query(
    `
      SELECT fm.id_movimiento
      FROM public.fidelizacion_movimientos fm
      INNER JOIN public.cat_fidelizacion_tipos_movimiento tm
        ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
      INNER JOIN public.cat_fidelizacion_origenes_movimiento om
        ON om.id_origen_movimiento = fm.id_origen_movimiento
      WHERE fm.id_factura = $1
        AND UPPER(TRIM(tm.codigo)) = 'ACUMULACION'
        AND UPPER(TRIM(om.codigo)) = 'FACTURA'
      LIMIT 1
    `,
    [facturaId]
  );

  if (existingResult.rowCount > 0) {
    return {
      created: false,
      reason: 'ALREADY_REGISTERED',
      idMovimiento: Number(existingResult.rows[0].id_movimiento)
    };
  }

  // Elegibilidad: snapshot historico si lo hay, perfil vigente si no. Este
  // camino es SOLO LECTURA -jamas escribe en telefonos/personas/empresas-.
  // Una escritura fallida aqui (p.ej. el UNIQUE de telefonos.telefono)
  // abortaria toda la transaccion en PostgreSQL y ningun try/catch de JS la
  // recuperaria, dejando la acumulacion rota de forma silenciosa.
  const perfilCompleto = eligibilitySnapshot
    ? Boolean(eligibilitySnapshot.perfilCompletoSnapshot)
    : isClienteProfileComplete(await fetchClienteProfileForFidelizacion(client, clienteId));

  if (!perfilCompleto) {
    return { created: false, reason: 'CLIENT_PROFILE_INCOMPLETE' };
  }

  const activeConfig = await getActiveFidelizacionConfig(client, sucursalId, referenceDate);
  if (!activeConfig) {
    return { created: false, reason: 'CONFIG_NOT_FOUND' };
  }
  if (!activeConfig.acumulacion_habilitada) {
    return { created: false, reason: 'ACCUMULATION_DISABLED' };
  }
  if (!(Number(activeConfig.lempiras_por_punto) > 0)) {
    return { created: false, reason: 'ACCUMULATION_RULE_NOT_CONFIGURED' };
  }

  const points = computeAccumulationPoints(montoFactura, activeConfig.lempiras_por_punto);
  if (points <= 0) {
    return { created: false, reason: 'POINTS_ROUND_DOWN_TO_ZERO' };
  }

  const catalogs = await resolveFidelizacionCatalogs(client);
  const movement = await addSaldoPoints({
    client,
    idCliente: clienteId,
    puntosDelta: points,
    movementIds: {
      idTipoMovimiento: catalogs.tipoAcumulacionId,
      idOrigenMovimiento: catalogs.origenFacturaId
    },
    idSucursal: sucursalId,
    idFactura: facturaId,
    idPedido,
    observacion: `Acumulacion automatica por factura ${buildVentaNumero(facturaId)}.`,
    idUsuarioEjecutor: parsePositiveInt(idUsuarioEjecutor)
  });

  return {
    created: true,
    points,
    idMovimiento: movement.idMovimiento,
    saldoAnterior: movement.saldoAnterior,
    saldoNuevo: movement.saldoNuevo
  };
};

const fetchClienteEstado = async (client, idCliente) => {
  const result = await client.query(
    `
      SELECT id_cliente, COALESCE(estado, true) AS estado
      FROM public.clientes
      WHERE id_cliente = $1
      LIMIT 1
    `,
    [idCliente]
  );

  return result.rows[0] || null;
};

// Resolucion centralizada producto maestro -> asignacion local (sucursal):
// unico punto de la app que decide, para un id_producto MAESTRO (el mismo
// que fidelizacion_productos_canjeables_sucursal.id_producto ya almacena),
// cual es su almacen/stock dentro de una sucursal especifica. Reemplaza el
// join legado (productos.id_almacen / productos.cantidad / productos.stock_minimo)
// que asumia un solo almacen por producto y por eso rechazaba productos
// maestros validos asignados a mas de una sucursal via productos_almacenes.
//
// Se usa desde configuracion (GET/PUT), el catalogo de canjeables (GET) y la
// confirmacion del canje (POST, con lockForUpdate=true) para no duplicar
// cuatro consultas incompatibles con la misma intencion.
//
// Contrato de retorno: Map<id_producto, resultado>, con resultado.status en
// { 'OK', 'SIN_ASIGNACION', 'AMBIGUA' }. 'SIN_ASIGNACION' cubre tanto la
// ausencia de asignacion activa como producto/asignacion/almacen inactivos
// (ninguno de esos casos es un producto local usable). 'AMBIGUA' es cuando
// el producto maestro tiene mas de una asignacion activa dentro de la MISMA
// sucursal (dos almacenes distintos de esa sucursal) y no hay una regla
// canonica para elegir uno: nunca se resuelve con LIMIT 1 ni MIN(id_almacen).
//
// FOR UPDATE no puede combinarse con funciones de ventana en el SELECT, asi
// que la deteccion de ambiguedad (COUNT... GROUP BY) y el fetch con lock se
// hacen en dos consultas separadas -- mismo patron ya usado en este repo por
// fetchProductosMaestrosByIdsForUpdate (services/inventarioStockValidator.js).
export const resolveFidelizacionProductAssignments = async ({
  client,
  idSucursal,
  productIds,
  lockForUpdate = false
}) => {
  // Defensa en profundidad: esta funcion se puede llamar directamente
  // (pruebas, otros servicios) sin pasar por la validacion del router, asi
  // que valida con el parser estricto en vez de confiar solo en el caller.
  const sucursalId = parseStrictPositiveInt(idSucursal);
  const uniqueIds = [...new Set(
    (Array.isArray(productIds) ? productIds : [])
      .map((id) => parseStrictPositiveInt(id))
      .filter((id) => id !== null)
  )];

  const resultMap = new Map();
  if (!sucursalId || uniqueIds.length === 0) return resultMap;

  const countsResult = await client.query(
    `
      SELECT pa.id_producto, COUNT(*)::int AS total_asignaciones
      FROM public.productos_almacenes pa
      INNER JOIN public.almacenes a
        ON a.id_almacen = pa.id_almacen
       AND a.id_sucursal = $1
       AND COALESCE(a.estado, true) = true
      INNER JOIN public.productos p
        ON p.id_producto = pa.id_producto
       AND COALESCE(p.estado, true) = true
      WHERE pa.id_producto = ANY($2::int[])
        AND COALESCE(pa.estado, true) = true
      GROUP BY pa.id_producto
    `,
    [sucursalId, uniqueIds]
  );
  const countsByProduct = new Map(
    countsResult.rows.map((row) => [Number(row.id_producto), Number(row.total_asignaciones || 0)])
  );

  const lockableIds = [];
  for (const idProducto of uniqueIds) {
    const total = countsByProduct.get(idProducto) || 0;
    if (total === 0) {
      resultMap.set(idProducto, { id_producto: idProducto, status: 'SIN_ASIGNACION' });
    } else if (total > 1) {
      resultMap.set(idProducto, { id_producto: idProducto, status: 'AMBIGUA' });
    } else {
      lockableIds.push(idProducto);
    }
  }

  if (lockableIds.length > 0) {
    // ORDER BY antes de FOR UPDATE: bloqueo en un orden deterministico
    // (id_producto, id_almacen) para reducir el riesgo de deadlock cuando
    // dos transacciones bloquean varios productos en distinto orden.
    const dataResult = await client.query(
      `
        SELECT
          p.id_producto,
          p.nombre_producto,
          COALESCE(p.descripcion_producto, '') AS descripcion_producto,
          p.precio,
          p.id_archivo_imagen_principal,
          pa.id_almacen,
          COALESCE(pa.cantidad, 0)::int AS cantidad,
          COALESCE(pa.stock_minimo, 0)::int AS stock_minimo,
          a.id_sucursal,
          COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacen #', a.id_almacen::text)) AS nombre_almacen
        FROM public.productos_almacenes pa
        INNER JOIN public.almacenes a
          ON a.id_almacen = pa.id_almacen
         AND a.id_sucursal = $1
         AND COALESCE(a.estado, true) = true
        INNER JOIN public.productos p
          ON p.id_producto = pa.id_producto
         AND COALESCE(p.estado, true) = true
        WHERE pa.id_producto = ANY($2::int[])
          AND COALESCE(pa.estado, true) = true
        ORDER BY pa.id_producto ASC, pa.id_almacen ASC
        ${lockForUpdate ? 'FOR UPDATE OF pa' : ''}
      `,
      [sucursalId, lockableIds]
    );

    // No se escribe cada fila directamente en resultMap: entre el COUNT de
    // arriba y este SELECT con lock, otra transaccion pudo crear/activar
    // una segunda asignacion (COUNT=1 ya no refleja la realidad bloqueada).
    // Se agrupan las filas REALMENTE bloqueadas por id_producto y la
    // decision final (OK/AMBIGUA/SIN_ASIGNACION) se basa en esa
    // agrupacion, nunca en el conteo previo ni en el orden accidental de
    // llegada de las filas.
    const lockedRowsByProduct = new Map();
    for (const row of dataResult.rows) {
      const idProducto = Number(row.id_producto);
      const rows = lockedRowsByProduct.get(idProducto) || [];
      rows.push(row);
      lockedRowsByProduct.set(idProducto, rows);
    }

    for (const idProducto of lockableIds) {
      const rows = lockedRowsByProduct.get(idProducto) || [];

      if (rows.length === 0) {
        // La unica asignacion detectada por el COUNT se desactivo/elimino
        // entre las dos consultas.
        resultMap.set(idProducto, { id_producto: idProducto, status: 'SIN_ASIGNACION' });
        continue;
      }

      if (rows.length > 1) {
        // Aparecio una segunda asignacion activa despues del COUNT: se
        // rechaza como ambigua, nunca se elige una fila arbitrariamente
        // (ni LIMIT 1, ni MIN(id_almacen), ni la ultima en llegar).
        resultMap.set(idProducto, { id_producto: idProducto, status: 'AMBIGUA' });
        continue;
      }

      const [row] = rows;
      const cantidad = Number(row.cantidad || 0);
      const stockMinimo = Number(row.stock_minimo || 0);
      resultMap.set(idProducto, {
        id_producto: idProducto,
        status: 'OK',
        nombre_producto: row.nombre_producto,
        descripcion_producto: row.descripcion_producto,
        precio: row.precio,
        id_archivo_imagen_principal: row.id_archivo_imagen_principal,
        id_sucursal: Number(row.id_sucursal),
        id_almacen: Number(row.id_almacen),
        nombre_almacen: row.nombre_almacen,
        cantidad,
        stock_minimo: stockMinimo,
        stock_disponible: Math.max(cantidad - stockMinimo, 0)
      });
    }
  }

  return resultMap;
};

const fetchCanjeProductRowsForUpdate = async (client, idSucursal, productIds) => {
  const uniqueIds = [...new Set(
    (Array.isArray(productIds) ? productIds : [])
      .map((id) => parseStrictPositiveInt(id))
      .filter((id) => id !== null)
  )];
  if (uniqueIds.length === 0) return [];

  const [canjeablesResult, assignments] = await Promise.all([
    client.query(
      `
        SELECT id_producto, puntos_requeridos_override, COALESCE(estado, true) AS canjeable_estado
        FROM public.fidelizacion_productos_canjeables_sucursal
        WHERE id_sucursal = $1
          AND id_producto = ANY($2::int[])
      `,
      [idSucursal, uniqueIds]
    ),
    resolveFidelizacionProductAssignments({
      client,
      idSucursal,
      productIds: uniqueIds,
      lockForUpdate: true
    })
  ]);

  const canjeablesByProduct = new Map(
    canjeablesResult.rows.map((row) => [Number(row.id_producto), row])
  );

  return uniqueIds.map((idProducto) => {
    const canjeable = canjeablesByProduct.get(idProducto) || null;
    const assignment = assignments.get(idProducto) || { id_producto: idProducto, status: 'SIN_ASIGNACION' };

    return {
      id_producto: idProducto,
      canjeable_estado: canjeable ? Boolean(canjeable.canjeable_estado) : false,
      puntos_requeridos_override: canjeable ? canjeable.puntos_requeridos_override : null,
      assignment_status: assignment.status,
      nombre_producto: assignment.nombre_producto,
      precio: assignment.precio,
      cantidad: assignment.cantidad,
      stock_minimo: assignment.stock_minimo,
      id_almacen: assignment.id_almacen
    };
  });
};

const insertInventoryMovement = async ({
  client,
  idAlmacen,
  idProducto,
  cantidad,
  idCanje
}) => {
  await client.query(
    `
      INSERT INTO public.movimientos_inventario (
        tipo,
        cantidad,
        id_almacen,
        id_producto,
        id_insumo,
        ref_origen,
        id_ref,
        descripcion
      )
      VALUES ('SALIDA', $1, $2, $3, NULL, 'CANJE', $4, $5)
    `,
    [
      cantidad,
      idAlmacen,
      idProducto,
      idCanje,
      `Salida por canje fidelizacion ${buildCanjeNumero(idCanje)}`
    ]
  );
};

// Exportada (no interna): el router debe poder validar y agregar los
// items ANTES de abrir conexion/transaccion (pool.connect/BEGIN), en vez de
// solo dentro de createPresentialFidelizacionCanje. La misma funcion se usa
// tambien dentro del servicio como defensa en profundidad (llamadas
// directas sin pasar por el router). Es idempotente sobre un arreglo ya
// agregado: cada id_producto aparece una sola vez en items ya agregados, asi
// que sumarlo consigo mismo una vez produce el mismo resultado.
export const validateAndAggregateCanjeItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw createFidelizacionError(
      400,
      'FIDELIZACION_CANJE_ITEMS_REQUIRED',
      'Debe enviar al menos un producto para canjear.'
    );
  }

  const byProduct = new Map();

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw createFidelizacionError(
        400,
        'FIDELIZACION_CANJE_ITEM_INVALID',
        'Cada item del canje debe ser un objeto valido.'
      );
    }

    // Cada id_producto y cantidad individual debe superar la validacion
    // estricta ANTES de agregarse: "156abc", "2.9", "2 OR 1=1", arreglos u
    // objetos se rechazan aqui, nunca se truncan a un id/cantidad distinta.
    const idProducto = parseStrictPositiveInt(item.id_producto);
    const cantidad = parseStrictPositiveInt(item.cantidad);

    if (!idProducto || !cantidad) {
      throw createFidelizacionError(
        400,
        'FIDELIZACION_CANJE_ITEM_INVALID',
        'Cada item debe incluir id_producto y cantidad enteros mayores a 0.'
      );
    }

    const current = byProduct.get(idProducto) || { id_producto: idProducto, cantidad: 0 };
    const nextCantidad = current.cantidad + cantidad;
    // La suma acumulada (articulos duplicados agregados) tambien debe
    // seguir siendo un entero seguro y positivo: un overflow se rechaza en
    // vez de continuar con un total incorrecto.
    if (!Number.isSafeInteger(nextCantidad) || nextCantidad <= 0) {
      throw createFidelizacionError(
        400,
        'FIDELIZACION_CANJE_ITEM_INVALID',
        'La cantidad total solicitada para un producto no es valida.'
      );
    }
    current.cantidad = nextCantidad;
    byProduct.set(idProducto, current);
  }

  return [...byProduct.values()];
};

// Fase 4 (seccion 3.8): sonda de esquema para
// fidelizacion_canjes.id_sesion_caja (migracion 20260728_fidelizacion_canjes_sesion_caja).
let canjesSesionCajaColumnExistsCache = null;
const hasFidelizacionCanjesSesionCajaColumn = async (client) => {
  if (canjesSesionCajaColumnExistsCache !== null) return canjesSesionCajaColumnExistsCache;
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fidelizacion_canjes'
        AND column_name = 'id_sesion_caja'
      LIMIT 1
    `
  );
  canjesSesionCajaColumnExistsCache = result.rowCount > 0;
  return canjesSesionCajaColumnExistsCache;
};

export const createPresentialFidelizacionCanje = async ({
  client,
  req,
  idCliente,
  idSucursal,
  idUsuarioEjecutor,
  idSesionCaja,
  items,
  observacion = null
}) => {
  // Defensa en profundidad: esta funcion se puede invocar directamente
  // (pruebas, otros servicios) sin pasar por routers/fidelizacion.js, asi
  // que valida con el parser estricto en vez de confiar en el caller
  // (parsePositiveInt truncaba "10x" -> 10, "1x" -> 1, "5x" -> 5 en
  // silencio).
  const clienteId = parseStrictPositiveInt(idCliente);
  const sucursalId = parseStrictPositiveInt(idSucursal);
  const actorId = parseStrictPositiveInt(idUsuarioEjecutor);
  const sesionCajaId = parseStrictPositiveInt(idSesionCaja);
  const safeObservation = normalizeText(observacion).slice(0, 200) || null;

  if (!clienteId) {
    throw createFidelizacionError(
      400,
      'FIDELIZACION_CLIENTE_INVALIDO',
      'El cliente seleccionado no es valido.'
    );
  }

  if (!sucursalId || !actorId) {
    throw createFidelizacionError(
      403,
      'FIDELIZACION_CANJE_SCOPE_ERROR',
      'No se pudo resolver la sucursal operativa del usuario.'
    );
  }

  // Validar y agregar items ANTES de tocar el cliente/DB (mismo orden que
  // ya exigia el resto de esta funcion): un payload con items invalidos no
  // debe ejecutar ninguna consulta.
  const aggregatedItems = validateAndAggregateCanjeItems(items);

  // Fase 4 (seccion 3.8): id_sesion_caja es obligatorio para TODO canje
  // presencial nuevo. El llamador (routers/fidelizacion.js) debe resolverlo
  // primero con resolveCanjeSesionCaja (que ya distingue cajero/administrador
  // y produce los codigos FIDELIZACION_CANJE_SESSION_* especificos); esta
  // funcion solo valida que efectivamente haya recibido un id positivo --
  // nunca continua con NULL para un canje nuevo.
  if (!sesionCajaId) {
    throw createFidelizacionError(
      400,
      'FIDELIZACION_CANJE_SESSION_REQUIRED',
      'Debe indicar la sesión de caja bajo la cual se registra el canje.'
    );
  }

  if (!(await hasFidelizacionCanjesSesionCajaColumn(client))) {
    throw createFidelizacionError(
      409,
      'FIDELIZACION_SCHEMA_PENDIENTE',
      'Falta aplicar la migracion de sesion de caja para canjes de fidelizacion; no se puede registrar el canje de forma auditable.'
    );
  }

  const cliente = await fetchClienteEstado(client, clienteId);
  if (!cliente || !Boolean(cliente.estado)) {
    throw createFidelizacionError(
      404,
      'FIDELIZACION_CLIENTE_NOT_FOUND',
      'El cliente seleccionado no esta disponible.'
    );
  }

  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [clienteId]);

  const saldo = await getClienteSaldoForUpdate(client, clienteId);
  if (!saldo) {
    throw createFidelizacionError(
      404,
      'FIDELIZACION_SALDO_NOT_FOUND',
      'No se encontro el saldo del cliente.'
    );
  }

  const activeConfig = await getActiveFidelizacionConfig(client, sucursalId);
  if (!activeConfig) {
    throw createFidelizacionError(
      409,
      'FIDELIZACION_CONFIG_NOT_FOUND',
      'La sucursal no tiene una configuracion de fidelizacion vigente.'
    );
  }

  const productRows = await fetchCanjeProductRowsForUpdate(
    client,
    sucursalId,
    aggregatedItems.map((item) => item.id_producto)
  );
  const productMap = new Map(productRows.map((row) => [Number(row.id_producto), row]));

  const detailRows = [];
  let totalPuntos = 0;

  for (const item of aggregatedItems) {
    const row = productMap.get(item.id_producto);
    if (!row || !Boolean(row.canjeable_estado)) {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_PRODUCTO_NOT_CANGEABLE',
        'Uno o mas productos no estan habilitados para canje en esta sucursal.'
      );
    }

    // assignment_status viene de resolveFidelizacionProductAssignments
    // (producto maestro + productos_almacenes + almacenes de esta sucursal,
    // bloqueado con FOR UPDATE OF pa). SIN_ASIGNACION cubre tanto la
    // ausencia de asignacion activa como producto/asignacion/almacen
    // inactivos: ninguno de esos casos deja un almacen local usable.
    if (row.assignment_status === 'AMBIGUA') {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_PRODUCTO_ASIGNACION_AMBIGUA',
        `El producto ${row.nombre_producto || item.id_producto} tiene mas de una asignacion activa en esta sucursal.`
      );
    }

    if (row.assignment_status !== 'OK') {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_PRODUCTO_SIN_ASIGNACION',
        `El producto ${row.nombre_producto || item.id_producto} no tiene una asignacion de inventario activa en esta sucursal.`
      );
    }

    const stockDisponible = Math.max(
      Number(row.cantidad || 0) - Number(row.stock_minimo || 0),
      0
    );

    if (stockDisponible < item.cantidad) {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_STOCK_INSUFFICIENT',
        `Stock insuficiente para ${row.nombre_producto || 'el producto solicitado'}.`
      );
    }

    const puntosUnitarios =
      parseNonNegativeInt(row.puntos_requeridos_override) ??
      computeRedemptionPoints(row.precio, activeConfig.lempiras_por_punto);

    if (!parsePositiveInt(puntosUnitarios)) {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_PRODUCTO_POINTS_INVALID',
        'Uno o mas productos no tienen una equivalencia de puntos valida.'
      );
    }

    const subtotalPuntos = puntosUnitarios * Number(item.cantidad);
    totalPuntos += subtotalPuntos;

    detailRows.push({
      id_producto: Number(item.id_producto),
      cantidad: Number(item.cantidad),
      puntos_unitarios: Number(puntosUnitarios),
      subtotal_puntos: Number(subtotalPuntos),
      precio_referencia: roundMoney(row.precio),
      nombre_producto: row.nombre_producto,
      id_almacen: Number(row.id_almacen)
    });
  }

  if (Number(saldo.puntos_disponibles || 0) < totalPuntos) {
    throw createFidelizacionError(
      409,
      'FIDELIZACION_SALDO_INSUFICIENTE',
      'El cliente no tiene puntos suficientes para completar el canje.'
    );
  }

  const catalogs = await resolveFidelizacionCatalogs(client);
  const canjeResult = await client.query(
    `
      INSERT INTO public.fidelizacion_canjes (
        id_cliente,
        id_sucursal,
        id_estado_canje,
        total_puntos,
        observacion,
        id_usuario_ejecutor,
        id_sesion_caja,
        fecha_creacion,
        fecha_entrega,
        fecha_anulacion
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NULL, NULL)
      RETURNING id_canje
    `,
    [
      clienteId,
      sucursalId,
      catalogs.estadoRegistradoId,
      totalPuntos,
      safeObservation,
      actorId,
      sesionCajaId
    ]
  );
  const idCanje = Number(canjeResult.rows?.[0]?.id_canje || 0);

  for (const row of detailRows) {
    await client.query(
      `
        INSERT INTO public.fidelizacion_canjes_detalle (
          id_canje,
          id_producto,
          cantidad,
          puntos_unitarios,
          subtotal_puntos,
          precio_referencia,
          fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `,
      [
        idCanje,
        row.id_producto,
        row.cantidad,
        row.puntos_unitarios,
        row.subtotal_puntos,
        row.precio_referencia
      ]
    );
  }

  const movement = await addSaldoPoints({
    client,
    idCliente: clienteId,
    puntosDelta: totalPuntos * -1,
    movementIds: {
      idTipoMovimiento: catalogs.tipoCanjeId,
      idOrigenMovimiento: catalogs.origenCanjeId
    },
    idSucursal: sucursalId,
    idCanje,
    observacion: safeObservation || `Canje presencial ${buildCanjeNumero(idCanje)}.`,
    idUsuarioEjecutor: actorId
  });

  for (const row of detailRows) {
    await insertInventoryMovement({
      client,
      idAlmacen: row.id_almacen,
      idProducto: row.id_producto,
      cantidad: row.cantidad,
      idCanje
    });
  }

  await insertFidelizacionAuditLog({
    client,
    req,
    idUsuario: actorId,
    accion: 'FIDELIZACION_CANJE_CREAR',
    descripcion: `Canje presencial ${buildCanjeNumero(idCanje)} registrado`,
    idRegistro: idCanje,
    datosDespues: {
      id_canje: idCanje,
      id_cliente: clienteId,
      id_sucursal: sucursalId,
      total_puntos: totalPuntos,
      saldo_anterior: movement.saldoAnterior,
      saldo_nuevo: movement.saldoNuevo,
      items: detailRows.map((row) => ({
        id_producto: row.id_producto,
        cantidad: row.cantidad,
        puntos_unitarios: row.puntos_unitarios,
        subtotal_puntos: row.subtotal_puntos
      }))
    }
  });

  return {
    idCanje,
    totalPuntos,
    saldoAnterior: movement.saldoAnterior,
    saldoNuevo: movement.saldoNuevo,
    idMovimiento: movement.idMovimiento,
    estadoCanjeId: catalogs.estadoRegistradoId,
    items: detailRows
  };
};

// Exportado UNICAMENTE para pruebas: los caches de sondas de esquema
// (hasFidelizacionAjustesPendientesTable, hasFidelizacionCanjesSesionCajaColumn)
// son a nivel de modulo/proceso -- necesario para no repetir la consulta a
// information_schema en cada llamada real, pero eso significa que dentro
// de una misma ejecucion de `node --test` (un solo proceso para muchos
// archivos) el primer resultado observado quedaria fijo para todo el resto
// de la suite. Esta funcion permite que un archivo de pruebas simule tanto
// "el esquema de Fase 4 ya se aplico" como "todavia no" en la misma
// ejecucion, sin afectar el comportamiento de produccion (nunca se llama
// fuera de pruebas).
export const __resetFidelizacionSchemaProbeCachesForTests = () => {
  ajustesPendientesTableExistsCache = null;
  canjesSesionCajaColumnExistsCache = null;
};

export {
  normalizeText,
  parsePositiveInt,
  parseStrictPositiveInt,
  parseNonNegativeInt,
  parsePositiveNumber,
  resolveEffectiveLempirasPorPunto,
  resolveEffectiveAcumulacionHabilitada,
  computeAccumulationPoints,
  computeRedemptionPoints
};
