import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
import {
  buildErrorBody,
  mapDbErrorToSafe,
  sanitizeApiErrorMessage,
  unknownFieldsFromPayload
} from '../utils/security/personasHardening.js';

const router = express.Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

const PLANILLA_FUNCTION_NAMES = Object.freeze([
  'fn_generar_planilla_mensual_por_sucursal',
  'fn_recalcular_detalle_planilla',
  'fn_recalcular_planilla_por_sucursal',
  'fn_listar_planillas_por_sucursal',
  'fn_listar_detalle_planilla',
  'fn_listar_empleados_activos_por_sucursal',
  'fn_listar_adelantos_pendientes_por_sucursal',
  'fn_listar_adelantos_aplicables_a_planilla',
  'fn_aplicar_adelanto_a_planilla',
  'fn_listar_resumen_planilla_por_sucursal',
  'fn_registrar_movimiento_planilla',
  'fn_listar_movimientos_planilla',
  'fn_listar_movimientos_planilla_detalle',
  'fn_anular_movimiento_planilla',
  'fn_actualizar_estado_planilla',
  'fn_planilla_completa_json',
  'fn_anular_planilla_completa',
  'fn_listar_auditoria_planilla'
]);

const PLANILLAS_VIEW_PERMISSIONS = ['PLANILLAS_LISTADO_VER'];
const PLANILLAS_DETAIL_PERMISSIONS = ['PLANILLAS_DETALLE_VER'];
const PLANILLAS_GENERATE_PERMISSIONS = ['PLANILLAS_GENERAR'];
const PLANILLAS_RECALCULAR_PERMISSIONS = ['PLANILLAS_RECALCULAR'];
const PLANILLAS_ADELANTOS_PERMISSIONS = ['PLANILLAS_ADELANTOS_APLICAR'];
const PLANILLAS_MOVIMIENTO_REGISTER_PERMISSIONS = ['PLANILLAS_MOVIMIENTO_REGISTRAR'];
const PLANILLAS_MOVIMIENTO_ANULAR_PERMISSIONS = ['PLANILLAS_MOVIMIENTO_ANULAR'];
const PLANILLAS_ESTADO_PERMISSIONS = ['PLANILLAS_CERRAR', 'PLANILLAS_PAGAR', 'PLANILLAS_ANULAR'];
const PLANILLAS_AUDITORIA_PERMISSIONS = ['PLANILLAS_AUDITORIA_VER'];

const PLANILLA_ENDPOINT_CONTRACT = Object.freeze({
  list: 'fn_listar_planillas_por_sucursal',
  generar: 'fn_generar_planilla_mensual_por_sucursal',
  recalcularPlanilla: 'fn_recalcular_planilla_por_sucursal',
  detalle: 'fn_listar_detalle_planilla',
  resumen: 'fn_listar_resumen_planilla_por_sucursal',
  completa: 'fn_planilla_completa_json',
  actualizarEstado: 'fn_actualizar_estado_planilla',
  anularPlanilla: 'fn_anular_planilla_completa',
  empleadosActivos: 'fn_listar_empleados_activos_por_sucursal',
  adelantosPendientes: 'fn_listar_adelantos_pendientes_por_sucursal',
  adelantosAplicables: 'fn_listar_adelantos_aplicables_a_planilla',
  aplicarAdelanto: 'fn_aplicar_adelanto_a_planilla',
  registrarMovimiento: 'fn_registrar_movimiento_planilla',
  movimientos: 'fn_listar_movimientos_planilla',
  movimientosDetalle: 'fn_listar_movimientos_planilla_detalle',
  anularMovimiento: 'fn_anular_movimiento_planilla',
  auditoria: 'fn_listar_auditoria_planilla',
  recalcularDetalle: 'fn_recalcular_detalle_planilla'
});
const GENERAR_ALLOWED_FIELDS = new Set([
  'id_sucursal',
  'periodo',
  'id_estado_planilla',
  'dias_laborados',
  'horas_laboradas'
]);
const ESTADO_ALLOWED_FIELDS = new Set([
  'id_estado_planilla',
  'id_estado',
  'estado',
  'recalcular'
]);
const ANULAR_ALLOWED_FIELDS = new Set(['usuario_accion']);
const APLICAR_ADELANTO_ALLOWED_FIELDS = new Set([
  'id_adelanto',
  'id_adelanto_salario',
  'monto_aplicar',
  'monto'
]);
const MOVIMIENTO_ALLOWED_FIELDS = new Set([
  'id_detalle',
  'id_detalle_planilla',
  'tipo',
  'tipo_movimiento',
  'concepto',
  'monto',
  'observacion'
]);

let planillaFunctionCatalogPromise;

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parsePositiveNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const sanitizeText = (value, maxLength = 200) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, maxLength);
};

const normalizePeriodo = (value) => {
  const text = sanitizeText(value, 10);
  if (!text) return null;
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
};

const normalizeEstadoAlias = (value) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!normalized) return null;

  const aliases = {
    ABIERTA: 'BORRADOR',
    BORRADOR: 'BORRADOR',
    CERRADA: 'CALCULADA',
    CALCULADA: 'CALCULADA',
    PAGADA: 'PAGADA',
    ANULADA: 'ANULADA'
  };

  return aliases[normalized] || normalized;
};

const toMonthKey = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

const parsePagination = (query = {}) => {
  const page = query.page === undefined ? 1 : parsePositiveInt(query.page);
  const requestedLimit = query.limit === undefined ? DEFAULT_LIMIT : parsePositiveInt(query.limit);
  if (!page || !requestedLimit) return null;
  return { page, limit: Math.min(requestedLimit, MAX_LIMIT) };
};

const paginateRows = (rows, page, limit) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  const total = safeRows.length;
  const start = (page - 1) * limit;
  const end = start + limit;
  return {
    items: safeRows.slice(start, end),
    total,
    page,
    limit
  };
};

const mapDbError = (err) => {
  if (!err) return null;

  if (err.code === 'PLANILLA_FN_MISSING') {
    return {
      status: 501,
      code: 'DB_FUNCTION_ERROR',
      message: 'La funcion SQL requerida no esta disponible en esta base de datos.'
    };
  }

  return mapDbErrorToSafe(err, {
    defaultMessage: 'No se pudo procesar la solicitud de planillas.'
  });
};

const isFunctionAllowed = (name) => PLANILLA_FUNCTION_NAMES.includes(name);

const getPlanillaFunctionCatalog = async () => {
  if (!planillaFunctionCatalogPromise) {
    planillaFunctionCatalogPromise = (async () => {
      const result = await pool.query(
        `
          SELECT p.proname
          FROM pg_proc p
          INNER JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = ANY($1::text[])
        `,
        [PLANILLA_FUNCTION_NAMES]
      );

      return new Set((result.rows || []).map((row) => row.proname));
    })().catch((err) => {
      planillaFunctionCatalogPromise = null;
      throw err;
    });
  }

  return planillaFunctionCatalogPromise;
};

const ensureFunctionInstalled = async (fnName) => {
  if (!isFunctionAllowed(fnName)) {
    throw new Error(`Función SQL no permitida: ${fnName}`);
  }

  const catalog = await getPlanillaFunctionCatalog();
  if (!catalog.has(fnName)) {
    const error = new Error(`La función ${fnName} no está instalada en la base de datos actual.`);
    error.code = 'PLANILLA_FN_MISSING';
    throw error;
  }
};

const buildFunctionSql = (fnName, argCount, asScalar = false) => {
  const placeholders = Array.from({ length: argCount }, (_, idx) => `$${idx + 1}`).join(', ');
  if (asScalar) return `SELECT ${fnName}(${placeholders}) AS value`;
  return `SELECT * FROM ${fnName}(${placeholders})`;
};

const queryFunctionRows = async (fnName, args = []) => {
  await ensureFunctionInstalled(fnName);
  const sql = buildFunctionSql(fnName, args.length, false);
  const result = await pool.query(sql, args);
  return result.rows || [];
};

const queryFunctionScalar = async (fnName, args = []) => {
  await ensureFunctionInstalled(fnName);
  const sql = buildFunctionSql(fnName, args.length, true);
  const result = await pool.query(sql, args);
  return result.rows?.[0]?.value ?? null;
};

const resolveEstadoPlanillaId = async (body = {}) => {
  const rawId = parsePositiveInt(body.id_estado_planilla ?? body.id_estado);
  if (rawId) {
    const rs = await pool.query(
      'SELECT id_estado_planilla, descripcion FROM estado_planilla WHERE id_estado_planilla = $1 LIMIT 1',
      [rawId]
    );
    if (!rs.rows.length) return null;
    return {
      idEstado: rs.rows[0].id_estado_planilla,
      descripcion: String(rs.rows[0].descripcion || '').trim()
    };
  }

  const estadoText = normalizeEstadoAlias(sanitizeText(body.estado, 60));
  if (!estadoText) return null;

  const rs = await pool.query(
    `
      SELECT id_estado_planilla, descripcion
      FROM estado_planilla
      WHERE UPPER(TRIM(descripcion)) = UPPER(TRIM($1))
      LIMIT 1
    `,
    [estadoText]
  );

  if (!rs.rows.length) return null;
  return {
    idEstado: rs.rows[0].id_estado_planilla,
    descripcion: String(rs.rows[0].descripcion || '').trim()
  };
};

const getRequiredEstadoPermission = (descripcion = '') => {
  const normalized = String(descripcion || '').trim().toUpperCase();
  if (normalized === 'CERRADA' || normalized === 'CALCULADA') return 'PLANILLAS_CERRAR';
  if (normalized === 'PAGADA') return 'PLANILLAS_PAGAR';
  if (normalized === 'ANULADA') return 'PLANILLAS_ANULAR';
  return null;
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    const result = await handler(req, res);
    return res.status(result.status).json(result.body);
  } catch (err) {
    const httpStatus = Number.isInteger(err?.httpStatus) ? err.httpStatus : null;
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      return res.status(httpStatus).json(
        buildErrorBody({
          code: err.code || 'REQUEST_ERROR',
          message: sanitizeApiErrorMessage(err.message, httpStatus)
        })
      );
    }

    const mappedError = mapDbError(err);
    if (mappedError) {
      return res.status(mappedError.status).json(
        buildErrorBody({ code: mappedError.code, message: mappedError.message })
      );
    }

    console.error('Planillas API error:', err.message);
    return res.status(500).json(
      buildErrorBody({
        code: 'INTERNAL_ERROR',
        message: 'No se pudo procesar la solicitud de planillas.'
      })
    );
  }
};

const planillaService = {
  async list(req) {
    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.list, []);

    const idSucursal = req.query.id_sucursal === undefined ? null : parsePositiveInt(req.query.id_sucursal);
    if (req.query.id_sucursal !== undefined && !idSucursal) {
      return { status: 400, body: { error: true, message: 'id_sucursal inválido' } };
    }

    const periodo = req.query.periodo === undefined ? null : normalizePeriodo(req.query.periodo);
    if (req.query.periodo !== undefined && !periodo) {
      return { status: 400, body: { error: true, message: 'periodo inválido. Use YYYY-MM o YYYY-MM-DD' } };
    }

    const search = sanitizeText(req.query.search ?? req.query.q, 120);
    const estado = req.query.estado === undefined
      ? null
      : normalizeEstadoAlias(sanitizeText(req.query.estado, 60));

    if (req.query.estado !== undefined && !estado) {
      return { status: 400, body: { error: true, message: 'estado invalido' } };
    }

    const periodoKey = periodo ? toMonthKey(periodo) : null;

    const filtered = rows.filter((row) => {
      if (idSucursal && parsePositiveInt(row.id_sucursal) !== idSucursal) return false;

      if (periodoKey) {
        const rowMonth = toMonthKey(row.fecha_creacion);
        if (rowMonth !== periodoKey) return false;
      }

      if (estado) {
        const estadoPlanilla = normalizeEstadoAlias(row.estado_planilla ?? row.estado);
        if (estadoPlanilla !== estado) return false;
      }

      if (search) {
        const haystack = [
          row.id_planilla,
          row.nombre_sucursal,
          row.estado_planilla,
          row.fecha_creacion,
          row.total_empleados
        ]
          .map((value) => String(value ?? '').toLowerCase())
          .join(' ');

        if (!haystack.includes(search.toLowerCase())) return false;
      }

      return true;
    });

    return {
      status: 200,
      body: {
        error: false,
        ...paginateRows(filtered, pagination.page, pagination.limit)
      }
    };
  },

  async generar(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, GENERAR_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idSucursal = parsePositiveInt(req.body?.id_sucursal);
    if (!idSucursal) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_sucursal es requerido.'
        })
      };
    }

    const fechaPlanilla = normalizePeriodo(req.body?.periodo) || new Date().toISOString().slice(0, 10);
    const idEstadoPlanilla = parsePositiveInt(req.body?.id_estado_planilla) || 1;
    const diasLaborados = parsePositiveNumber(req.body?.dias_laborados) || 30;
    const horasLaboradas = parsePositiveNumber(req.body?.horas_laboradas) || 240;

    const idPlanilla = await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.generar, [
      idSucursal,
      fechaPlanilla,
      idEstadoPlanilla,
      diasLaborados,
      horasLaboradas
    ]);

    return {
      status: 201,
      body: {
        error: false,
        message: 'Planilla generada correctamente',
        data: { id_planilla: idPlanilla }
      }
    };
  },

  async recalcularPlanilla(req) {
    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla inválido' } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.recalcularPlanilla, [idPlanilla]);
    return {
      status: 200,
      body: { error: false, message: 'Planilla recalculada correctamente', data: rows[0] || null }
    };
  },

  async detalle(req) {
    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla inválido' } };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const search = sanitizeText(req.query.search ?? req.query.q, 120);

    const filtered = rows.filter((row) => {
      if (!search) return true;
      const haystack = [
        row.id_empleado,
        row.nombre_completo,
        row.sucursal,
        row.cargo,
        row.salario_base,
        row.total_bonos,
        row.total_deducciones,
        row.neto_pagar
      ]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      return haystack.includes(search.toLowerCase());
    });

    return {
      status: 200,
      body: {
        error: false,
        ...paginateRows(filtered, pagination.page, pagination.limit)
      }
    };
  },

  async resumen(req) {
    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla inválido' } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.resumen, [idPlanilla]);
    return { status: 200, body: { error: false, data: rows[0] || null } };
  },

  async completa(req) {
    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla inválido' } };
    }

    const data = await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.completa, [idPlanilla]);
    return { status: 200, body: { error: false, data } };
  },

  async actualizarEstado(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, ESTADO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_planilla invalido.' })
      };
    }

    const estadoInfo = await resolveEstadoPlanillaId(req.body || {});
    if (!estadoInfo) {
      return {
        status: 400,
        body: { error: true, message: 'id_estado_planilla/estado inválido o no existe en catálogo' }
      };
    }

    const requiredPermission = getRequiredEstadoPermission(estadoInfo.descripcion);
    if (requiredPermission) {
      const hasPermission = await requestHasAnyPermission(req, [requiredPermission]);
      if (!hasPermission) {
        return {
          status: 403,
          body: buildErrorBody({
            code: 'FORBIDDEN',
            message: `No tiene permiso ${requiredPermission} para este cambio de estado.`
          })
        };
      }
    }

    const recalcular = req.body?.recalcular === undefined ? true : Boolean(req.body.recalcular);
    await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.actualizarEstado, [
      idPlanilla,
      estadoInfo.idEstado,
      recalcular
    ]);

    return {
      status: 200,
      body: {
        error: false,
        message: `Estado de planilla actualizado a ${estadoInfo.descripcion}`
      }
    };
  },

  async anularPlanilla(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, ANULAR_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_planilla invalido.' })
      };
    }

    const usuarioAccion = sanitizeText(req.body?.usuario_accion, 100) || String(req.user?.id_usuario || 'sistema');
    await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.anularPlanilla, [idPlanilla, usuarioAccion]);

    return {
      status: 200,
      body: { error: false, message: 'Planilla anulada correctamente' }
    };
  },

  async empleadosActivos(req) {
    const idSucursal = parsePositiveInt(req.params.id_sucursal);
    if (!idSucursal) {
      return { status: 400, body: { error: true, message: 'id_sucursal inválido' } };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.empleadosActivos, [idSucursal]);
    const search = sanitizeText(req.query.search ?? req.query.q, 120);
    const filtered = rows.filter((row) => {
      if (!search) return true;
      const haystack = [row.nombre_completo, row.dni, row.cargo, row.telefono, row.correo]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      return haystack.includes(search.toLowerCase());
    });

    return {
      status: 200,
      body: { error: false, ...paginateRows(filtered, pagination.page, pagination.limit) }
    };
  },

  async adelantosPendientes(req) {
    const idSucursal = parsePositiveInt(req.params.id_sucursal);
    if (!idSucursal) {
      return { status: 400, body: { error: true, message: 'id_sucursal inválido' } };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.adelantosPendientes, [idSucursal]);
    const periodo = req.query.periodo ? normalizePeriodo(req.query.periodo) : null;
    if (req.query.periodo && !periodo) {
      return { status: 400, body: { error: true, message: 'periodo inválido. Use YYYY-MM o YYYY-MM-DD' } };
    }

    const periodoKey = periodo ? toMonthKey(periodo) : null;
    const search = sanitizeText(req.query.search ?? req.query.q, 120);

    const filtered = rows.filter((row) => {
      if (periodoKey && toMonthKey(row.fecha) !== periodoKey) return false;
      if (!search) return true;
      const haystack = [row.nombre_completo, row.cargo, row.monto, row.saldo, row.fecha]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      return haystack.includes(search.toLowerCase());
    });

    return {
      status: 200,
      body: { error: false, ...paginateRows(filtered, pagination.page, pagination.limit) }
    };
  },

  async adelantosAplicables(req) {
    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla inválido' } };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    let rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.adelantosAplicables, [idPlanilla]);

    const idDetalle = req.query.id_detalle === undefined ? null : parsePositiveInt(req.query.id_detalle);
    if (req.query.id_detalle !== undefined && !idDetalle) {
      return { status: 400, body: { error: true, message: 'id_detalle inválido' } };
    }

    if (idDetalle) {
      const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
      const detalle = detalleRows.find((row) => parsePositiveInt(row.id_detalle_planilla) === idDetalle);
      if (!detalle) {
        return { status: 404, body: { error: true, message: 'Detalle de planilla no encontrado' } };
      }

      const idEmpleado = parsePositiveInt(detalle.id_empleado);
      if (idEmpleado) {
        rows = rows.filter((row) => parsePositiveInt(row.id_empleado) === idEmpleado);
      }
    }

    return {
      status: 200,
      body: { error: false, ...paginateRows(rows, pagination.page, pagination.limit) }
    };
  },

  async aplicarAdelanto(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, APLICAR_ADELANTO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idAdelanto = parsePositiveInt(req.body?.id_adelanto ?? req.body?.id_adelanto_salario);
    const montoAplicar = parsePositiveNumber(req.body?.monto_aplicar ?? req.body?.monto);

    if (!idPlanilla || !idAdelanto) {
      return { status: 400, body: { error: true, message: 'id_planilla e id_adelanto son requeridos' } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.aplicarAdelanto, [
      idAdelanto,
      idPlanilla,
      montoAplicar
    ]);

    return {
      status: 200,
      body: {
        error: false,
        message: 'Adelanto aplicado correctamente',
        data: rows[0] || null
      }
    };
  },

  async registrarMovimiento(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, MOVIMIENTO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idDetalle = parsePositiveInt(req.body?.id_detalle ?? req.body?.id_detalle_planilla);
    const tipo = sanitizeText(req.body?.tipo ?? req.body?.tipo_movimiento, 20);
    const concepto = sanitizeText(req.body?.concepto, 100);
    const monto = parsePositiveNumber(req.body?.monto);
    const observacion = sanitizeText(req.body?.observacion, 255);

    if (!idPlanilla || !idDetalle || !tipo || !concepto || !monto) {
      return {
        status: 400,
        body: { error: true, message: 'id_planilla, id_detalle, tipo, concepto y monto son requeridos' }
      };
    }

    const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const detalleValido = detalleRows.some((row) => parsePositiveInt(row.id_detalle_planilla) === idDetalle);
    if (!detalleValido) {
      return {
        status: 404,
        body: { error: true, message: 'El detalle indicado no pertenece a la planilla seleccionada' }
      };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.registrarMovimiento, [
      idDetalle,
      tipo.toUpperCase(),
      concepto,
      monto,
      observacion
    ]);

    return {
      status: 201,
      body: {
        error: false,
        message: 'Movimiento registrado correctamente',
        data: rows[0] || null
      }
    };
  },

  async listarMovimientos(req) {
    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla inválido' } };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const idDetalle = req.query.id_detalle === undefined ? null : parsePositiveInt(req.query.id_detalle);
    if (req.query.id_detalle !== undefined && !idDetalle) {
      return { status: 400, body: { error: true, message: 'id_detalle inválido' } };
    }

    let rows = [];

    if (idDetalle) {
      rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.movimientos, [idDetalle]);
    } else {
      const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
      const detailIds = detalleRows
        .map((row) => parsePositiveInt(row.id_detalle_planilla))
        .filter(Boolean);

      const chunks = await Promise.all(
        detailIds.map((detailId) => queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.movimientos, [detailId]))
      );

      rows = chunks.flat();
    }

    rows.sort((a, b) => {
      const left = new Date(a.fecha_registro || 0).getTime();
      const right = new Date(b.fecha_registro || 0).getTime();
      return right - left;
    });

    return {
      status: 200,
      body: { error: false, ...paginateRows(rows, pagination.page, pagination.limit) }
    };
  },

  async listarMovimientosDetalle(req) {
    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idDetalle = parsePositiveInt(req.params.id_detalle);

    if (!idPlanilla || !idDetalle) {
      return { status: 400, body: { error: true, message: 'id_planilla e id_detalle son requeridos' } };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.movimientosDetalle, [idDetalle]);
    const filtered = rows.filter((row) => parsePositiveInt(row.id_planilla) === idPlanilla);

    return {
      status: 200,
      body: { error: false, ...paginateRows(filtered, pagination.page, pagination.limit) }
    };
  },

  async anularMovimiento(req) {
    const idMovimiento = parsePositiveInt(req.params.id_movimiento);
    if (!idMovimiento) {
      return { status: 400, body: { error: true, message: 'id_movimiento inválido' } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.anularMovimiento, [idMovimiento]);

    return {
      status: 200,
      body: {
        error: false,
        message: 'Movimiento anulado correctamente',
        data: rows[0] || null
      }
    };
  },

  async auditoria(req) {
    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla inválido' } };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const entidad = sanitizeText(req.query.entidad, 50);
    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.auditoria, [entidad]);

    const planillaNeedle = `planilla ${idPlanilla}`;
    const planillaNeedleAlt = `planilla: ${idPlanilla}`;

    const filtered = rows.filter((row) => {
      if (parsePositiveInt(row.id_referencia) === idPlanilla) return true;
      const desc = String(row.descripcion || '').toLowerCase();
      return desc.includes(planillaNeedle) || desc.includes(planillaNeedleAlt);
    });

    return {
      status: 200,
      body: { error: false, ...paginateRows(filtered, pagination.page, pagination.limit) }
    };
  },

  async recalcularDetalle(req) {
    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idDetalle = parsePositiveInt(req.params.id_detalle);

    if (!idPlanilla || !idDetalle) {
      return { status: 400, body: { error: true, message: 'id_planilla e id_detalle son requeridos' } };
    }

    const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const detalleValido = detalleRows.some((row) => parsePositiveInt(row.id_detalle_planilla) === idDetalle);
    if (!detalleValido) {
      return {
        status: 404,
        body: { error: true, message: 'El detalle indicado no pertenece a la planilla seleccionada' }
      };
    }

    const netoActualizado = await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.recalcularDetalle, [idDetalle]);

    return {
      status: 200,
      body: {
        error: false,
        message: 'Detalle recalculado correctamente',
        data: { id_planilla: idPlanilla, id_detalle_planilla: idDetalle, neto_actualizado: netoActualizado }
      }
    };
  }
};

router.get('/planillas', checkPermission(PLANILLAS_VIEW_PERMISSIONS), asyncHandler(planillaService.list));
router.post('/planillas/generar', checkPermission(PLANILLAS_GENERATE_PERMISSIONS), asyncHandler(planillaService.generar));
router.post('/planillas/:id_planilla/recalcular', checkPermission(PLANILLAS_RECALCULAR_PERMISSIONS), asyncHandler(planillaService.recalcularPlanilla));
router.get('/planillas/:id_planilla/detalle', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.detalle));
router.get('/planillas/:id_planilla/resumen', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.resumen));
router.get('/planillas/:id_planilla/completa', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.completa));
router.put('/planillas/:id_planilla/estado', checkPermission(PLANILLAS_ESTADO_PERMISSIONS), asyncHandler(planillaService.actualizarEstado));
router.post('/planillas/:id_planilla/anular', checkPermission(['PLANILLAS_ANULAR']), asyncHandler(planillaService.anularPlanilla));
router.get('/planillas/sucursales/:id_sucursal/empleados-activos', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.empleadosActivos));
router.get('/planillas/sucursales/:id_sucursal/adelantos-pendientes', checkPermission(PLANILLAS_ADELANTOS_PERMISSIONS), asyncHandler(planillaService.adelantosPendientes));
router.get('/planillas/:id_planilla/adelantos-aplicables', checkPermission(PLANILLAS_ADELANTOS_PERMISSIONS), asyncHandler(planillaService.adelantosAplicables));
router.post('/planillas/:id_planilla/adelantos/aplicar', checkPermission(PLANILLAS_ADELANTOS_PERMISSIONS), asyncHandler(planillaService.aplicarAdelanto));
router.post('/planillas/:id_planilla/movimientos', checkPermission(PLANILLAS_MOVIMIENTO_REGISTER_PERMISSIONS), asyncHandler(planillaService.registrarMovimiento));
router.get('/planillas/:id_planilla/movimientos', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.listarMovimientos));
router.get('/planillas/:id_planilla/movimientos/:id_detalle', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.listarMovimientosDetalle));
router.post('/planillas/movimientos/:id_movimiento/anular', checkPermission(PLANILLAS_MOVIMIENTO_ANULAR_PERMISSIONS), asyncHandler(planillaService.anularMovimiento));
router.get('/planillas/:id_planilla/auditoria', checkPermission(PLANILLAS_AUDITORIA_PERMISSIONS), asyncHandler(planillaService.auditoria));
router.post('/planillas/:id_planilla/detalle/:id_detalle/recalcular', checkPermission(PLANILLAS_RECALCULAR_PERMISSIONS), asyncHandler(planillaService.recalcularDetalle));

export default router;

