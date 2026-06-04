import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import {
  buildErrorBody,
  mapDbErrorToSafe,
  sanitizeApiErrorMessage,
  isValidDateOnly,
  isFutureDateOnly,
  isSafePhoneHN,
  isSafeHumanName,
  unknownFieldsFromPayload
} from '../utils/security/personasHardening.js';

const router = express.Router();
const EMPLEADOS_LIST_PERMISSIONS = ['EMPLEADOS_LISTADO_VER'];
const EMPLEADOS_DETAIL_PERMISSIONS = ['EMPLEADOS_DETALLE_VER'];
const EMPLEADOS_CREATE_PERMISSIONS = ['EMPLEADOS_CREAR'];
const EMPLEADOS_EDIT_PERMISSIONS = ['EMPLEADOS_EDITAR'];
const EMPLEADOS_DELETE_PERMISSIONS = ['EMPLEADOS_ELIMINAR'];

const MAX_LIMIT = 100;
const BASE_FIELDS = ['id_empleado', 'fecha_ingreso', 'salario_base', 'estado', 'id_sucursal', 'id_persona'];
const OPTIONAL_SOFT_DELETE_FIELDS = ['estado', 'activo', 'habilitado'];
const FUNCTION_UPDATE_FIELDS = new Set([
  'fecha_ingreso',
  'salario_base',
  'estado',
  'id_sucursal',
  'id_persona',
  'id_cargo',
  'cargo',
  'nombre_referencia',
  'telefono_referencia'
]);

let schemaCapabilitiesPromise;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseBooleanFilter = (value) => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 't', 'si', 'activo'].includes(normalized)) return true;
  if (['false', '0', 'f', 'no', 'inactivo'].includes(normalized)) return false;
  return null;
};

const resolveUserId = (req) => req.user?.id_usuario ?? null;
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const hasTextValue = (value) => value !== null && value !== undefined && String(value).trim() !== '';
const rollbackQuietly = async (client) => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // noop
  }
};

const normalizeLegacyUpdatePayload = (body) => {
  if (!isPlainObject(body)) return null;
  if (!hasOwn(body, 'campo')) return null;

  const campo = typeof body.campo === 'string' ? body.campo.trim() : '';
  if (!campo || body.valor === undefined) return null;
  return { [campo]: body.valor };
};

const mapEmpleadoListRow = (row) => {
  const personaNombre = row.persona_nombre ?? row.nombre ?? null;
  const personaApellido = row.persona_apellido ?? row.apellido ?? null;
  const personaDni = row.persona_dni ?? row.dni ?? null;
  const fullNameFromParts = [personaNombre, personaApellido].filter(Boolean).join(' ').trim();
  const personaNombreCompleto =
    row.persona_nombre_completo ??
    row.nombre_completo ??
    (fullNameFromParts || null);
  const sucursalNombre = row.sucursal_nombre ?? row.nombre_sucursal ?? row.sucursal ?? null;
  const telefono =
    row.telefono ??
    row.texto_telefono ??
    row.telefono_texto ??
    row.persona_telefono ??
    row.telefono_persona ??
    null;
  const correo =
    row.correo ??
    row.texto_correo ??
    row.correo_texto ??
    row.direccion_correo ??
    row.email ??
    null;
  const direccion =
    row.direccion ??
    row.texto_direccion ??
    row.direccion_texto ??
    row.persona_direccion ??
    row.direccion_persona ??
    null;

  return {
    ...row,
    persona_nombre: personaNombre,
    persona_apellido: personaApellido,
    persona_dni: personaDni,
    persona_nombre_completo: personaNombreCompleto,
    nombre_completo: personaNombreCompleto,
    sucursal_nombre: sucursalNombre,
    nombre_sucursal: row.nombre_sucursal ?? sucursalNombre,
    telefono,
    correo,
    direccion
  };
};

const mapDbError = (err) => {
  return mapDbErrorToSafe(err, {
    defaultMessage: 'No se pudo procesar la solicitud de empleados.'
  });
};

const validateEmpleadoPayload = (payload = {}, { requirePersona = false, requireSucursal = false, requireCargo = false } = {}) => {
  const errors = [];

  if (requirePersona && !parsePositiveInt(payload.id_persona)) {
    errors.push({ field: 'id_persona', message: 'id_persona es requerido y debe ser entero positivo.' });
  }

  if (requireSucursal && !parsePositiveInt(payload.id_sucursal)) {
    errors.push({ field: 'id_sucursal', message: 'id_sucursal es requerido y debe ser entero positivo.' });
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'salario_base')) {
    const salary = Number(payload.salario_base);
    if (!Number.isFinite(salary) || salary < 0) {
      errors.push({ field: 'salario_base', message: 'salario_base debe ser un numero valido mayor o igual a 0.' });
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'fecha_ingreso')) {
    const date = String(payload.fecha_ingreso ?? '').trim();
    if (date && (!isValidDateOnly(date) || isFutureDateOnly(date))) {
      errors.push({ field: 'fecha_ingreso', message: 'fecha_ingreso no es valida.' });
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'telefono_referencia')) {
    const phone = String(payload.telefono_referencia ?? '').trim();
    if (phone && !isSafePhoneHN(phone)) {
      errors.push({ field: 'telefono_referencia', message: 'telefono_referencia debe tener formato ####-####.' });
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'nombre_referencia')) {
    const name = String(payload.nombre_referencia ?? '').trim();
    if (name && !isSafeHumanName(name)) {
      errors.push({ field: 'nombre_referencia', message: 'nombre_referencia solo puede contener letras y espacios.' });
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'id_cargo')) {
    const idCargo = parsePositiveInt(payload.id_cargo);
    if (payload.id_cargo !== null && payload.id_cargo !== '' && !idCargo) {
      errors.push({ field: 'id_cargo', message: 'id_cargo debe ser entero positivo.' });
    }
  }

  if (requireCargo) {
    const idCargo = parsePositiveInt(payload.id_cargo);
    const cargoTexto = String(payload.cargo ?? '').trim();
    if (!idCargo && !cargoTexto) {
      errors.push({ field: 'cargo', message: 'Debe indicar un cargo valido para el empleado.' });
    }
  }

  return errors;
};

const getSchemaCapabilities = async () => {
  if (!schemaCapabilitiesPromise) {
    schemaCapabilitiesPromise = (async () => {
      const tableColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'empleados'
      `;

      const personasColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'personas'
      `;

      const sucursalesColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sucursales'
      `;

      const relatedTablesQuery = `
        SELECT
          to_regclass('public.personas') AS personas_table,
          to_regclass('public.sucursales') AS sucursales_table,
          to_regclass('public.direcciones') AS direcciones_table,
          to_regclass('public.telefonos') AS telefonos_table,
          to_regclass('public.correos') AS correos_table,
          to_regclass('public.bitacoras') AS bitacoras_table
      `;

      const [columnsResult, personasColumnsResult, relatedTablesResult] = await Promise.all([
        pool.query(tableColumnsQuery),
        pool.query(personasColumnsQuery),
        pool.query(relatedTablesQuery)
      ]);

      const columns = new Set(columnsResult.rows.map((row) => row.column_name));
      const personasColumns = new Set(personasColumnsResult.rows.map((row) => row.column_name));
      const relatedTables = relatedTablesResult.rows[0] || {};
      const hasSucursalesTable = Boolean(relatedTables.sucursales_table);

      let sucursalNameField = null;
      if (hasSucursalesTable) {
        const sucursalesColumnsResult = await pool.query(sucursalesColumnsQuery);
        const sucursalesColumns = new Set(sucursalesColumnsResult.rows.map((row) => row.column_name));
        sucursalNameField =
          ['nombre_sucursal', 'nombre', 'sucursal'].find((field) => sucursalesColumns.has(field)) || null;
      }

      const softDeleteField = OPTIONAL_SOFT_DELETE_FIELDS.find((field) => columns.has(field)) || null;

      return {
        columns,
        softDeleteField,
        hasCreatedBy: columns.has('created_by'),
        hasUpdatedBy: columns.has('updated_by'),
        hasTenantField: columns.has('id_empresa'),
        hasPersonasTable: Boolean(relatedTables.personas_table),
        hasDireccionesTable: Boolean(relatedTables.direcciones_table),
        hasTelefonosTable: Boolean(relatedTables.telefonos_table),
        hasCorreosTable: Boolean(relatedTables.correos_table),
        hasPersonaTenantField: personasColumns.has('id_empresa'),
        hasSucursalesTable,
        sucursalNameField,
        hasBitacorasTable: Boolean(relatedTables.bitacoras_table)
      };
    })().catch((err) => {
      schemaCapabilitiesPromise = null;
      throw err;
    });
  }

  return schemaCapabilitiesPromise;
};

const empleadoRepository = {
  async list() {
    const result = await pool.query('SELECT * FROM empleados_listar()');
    return result.rows;
  },

  async searchWithPagination({
    capabilities,
    page,
    limit,
    searchTerm = '',
    estado = null,
    idSucursal = null,
    tenantId = null
  }) {
    const filters = [];
    const params = [];

    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replaceAll('$IDX', `$${params.length}`));
    };

    if (searchTerm) {
      const value = `%${searchTerm}%`;
      const searchFragments = [
        'e.id_empleado::TEXT ILIKE $IDX',
        "COALESCE(e.salario_base::TEXT, '') ILIKE $IDX",
        "COALESCE(e.cargo, '') ILIKE $IDX",
        "COALESCE(e.nombre_referencia, '') ILIKE $IDX",
        "COALESCE(e.telefono_referencia, '') ILIKE $IDX"
      ];

      if (capabilities.hasPersonasTable) {
        searchFragments.push("COALESCE(p.nombre, '') ILIKE $IDX");
        searchFragments.push("COALESCE(p.apellido, '') ILIKE $IDX");
        searchFragments.push("NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), '') ILIKE $IDX");
        searchFragments.push("NULLIF(TRIM(CONCAT(COALESCE(p.apellido, ''), ' ', COALESCE(p.nombre, ''))), '') ILIKE $IDX");
        searchFragments.push("COALESCE(p.dni::TEXT, '') ILIKE $IDX");
        if (capabilities.hasTelefonosTable) {
          searchFragments.push("COALESCE(telf.telefono, '') ILIKE $IDX");
        }
        if (capabilities.hasCorreosTable) {
          searchFragments.push("COALESCE(cor.direccion_correo, '') ILIKE $IDX");
        }
        if (capabilities.hasDireccionesTable) {
          searchFragments.push("COALESCE(dir.direccion, '') ILIKE $IDX");
        }
      }

      if (capabilities.hasSucursalesTable && capabilities.sucursalNameField) {
        searchFragments.push(`COALESCE(s.${capabilities.sucursalNameField}, '') ILIKE $IDX`);
      }

      if (capabilities.softDeleteField) {
        searchFragments.push(`COALESCE(e.${capabilities.softDeleteField}::TEXT, '') ILIKE $IDX`);
      }

      pushFilter(`(${searchFragments.join(' OR ')})`, value);
    }

    if (estado !== null && capabilities.softDeleteField) {
      pushFilter(`e.${capabilities.softDeleteField} = $IDX`, estado);
    }

    if (idSucursal) {
      pushFilter('e.id_sucursal = $IDX', idSucursal);
    }

    if (tenantId) {
      if (capabilities.hasTenantField) {
        pushFilter('e.id_empresa = $IDX', tenantId);
      } else if (capabilities.hasPersonasTable && capabilities.hasPersonaTenantField) {
        pushFilter('p.id_empresa = $IDX', tenantId);
      }
    }

    const fields = [
      'e.id_empleado',
      'e.fecha_ingreso',
      'e.salario_base',
      'e.cargo',
      'e.nombre_referencia',
      'e.telefono_referencia',
      'e.id_sucursal',
      'e.id_persona'
    ];

    if (capabilities.hasTenantField) {
      fields.push('e.id_empresa');
    } else {
      fields.push('NULL::INT AS id_empresa');
    }

    if (capabilities.softDeleteField) {
      fields.push(`e.${capabilities.softDeleteField}`);
      if (capabilities.softDeleteField !== 'estado') {
        fields.push(`e.${capabilities.softDeleteField} AS estado`);
      }
    } else {
      fields.push('NULL::BOOLEAN AS estado');
    }

    if (capabilities.hasPersonasTable) {
      fields.push('p.nombre AS persona_nombre');
      fields.push('p.apellido AS persona_apellido');
      fields.push('p.dni AS persona_dni');
      fields.push(`TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS persona_nombre_completo`);
      if (capabilities.hasTelefonosTable) {
        fields.push('telf.telefono');
      } else {
        fields.push('NULL::TEXT AS telefono');
      }
      if (capabilities.hasCorreosTable) {
        fields.push('cor.direccion_correo AS correo');
      } else {
        fields.push('NULL::TEXT AS correo');
      }
      if (capabilities.hasDireccionesTable) {
        fields.push('dir.direccion');
      } else {
        fields.push('NULL::TEXT AS direccion');
      }
      if (capabilities.hasPersonaTenantField) {
        fields.push('p.id_empresa AS persona_id_empresa');
      } else {
        fields.push('NULL::INT AS persona_id_empresa');
      }
    } else {
      fields.push('NULL::TEXT AS persona_nombre');
      fields.push('NULL::TEXT AS persona_apellido');
      fields.push('NULL::TEXT AS persona_dni');
      fields.push('NULL::TEXT AS persona_nombre_completo');
      fields.push('NULL::TEXT AS telefono');
      fields.push('NULL::TEXT AS correo');
      fields.push('NULL::TEXT AS direccion');
      fields.push('NULL::INT AS persona_id_empresa');
    }

    if (capabilities.hasSucursalesTable && capabilities.sucursalNameField) {
      fields.push(`s.${capabilities.sucursalNameField} AS sucursal_nombre`);
    } else {
      fields.push('NULL::TEXT AS sucursal_nombre');
    }

    const joins = [];
    if (capabilities.hasPersonasTable) {
      joins.push('LEFT JOIN public.personas p ON p.id_persona = e.id_persona');
      if (capabilities.hasTelefonosTable) {
        joins.push('LEFT JOIN public.telefonos telf ON telf.id_telefono = p.id_telefono');
      }
      if (capabilities.hasCorreosTable) {
        joins.push('LEFT JOIN public.correos cor ON cor.id_correo = p.id_correo');
      }
      if (capabilities.hasDireccionesTable) {
        joins.push('LEFT JOIN public.direcciones dir ON dir.id_direccion = p.id_direccion');
      }
    }
    if (capabilities.hasSucursalesTable && capabilities.sucursalNameField) {
      joins.push('LEFT JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal');
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const joinsSql = joins.length ? `\n${joins.join('\n')}` : '';
    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];
    const fieldsWithTotal = [...fields, 'COUNT(*) OVER()::INT AS __total__'];

    const dataQuery = `
      SELECT ${fieldsWithTotal.join(', ')}
      FROM public.empleados e${joinsSql}
      ${where}
      ORDER BY e.id_empleado ASC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const dataResult = await pool.query(dataQuery, dataParams);
    let total = Number(dataResult.rows?.[0]?.__total__) || 0;

    const data = dataResult.rows.map((row) => {
      const { __total__, ...empleado } = row;
      if (!capabilities.softDeleteField) return empleado;

      const estadoActual = parseBooleanFilter(String(empleado?.[capabilities.softDeleteField] ?? empleado?.estado));
      const safeEstado = estadoActual === null ? false : Boolean(estadoActual);
      return {
        ...empleado,
        [capabilities.softDeleteField]: safeEstado,
        estado: safeEstado
      };
    });

    if (data.length === 0) {
      const totalQuery = `
        SELECT COUNT(*)::INT AS total
        FROM public.empleados e${joinsSql}
        ${where}
      `;
      const totalResult = await pool.query(totalQuery, params);
      total = Number(totalResult.rows?.[0]?.total) || 0;
    }

    return { data, total };
  },

  async findDetailById(idEmpleado) {
    const result = await pool.query(
      'SELECT * FROM empleados_listar() WHERE id_empleado = $1 LIMIT 1',
      [idEmpleado]
    );
    return result.rows[0] || null;
  },

  async backfillDirecciones(rows, capabilities) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    if (!capabilities?.hasPersonasTable || !capabilities?.hasDireccionesTable) return rows;

    const personaIds = [
      ...new Set(
        rows
          .map((row) => parsePositiveInt(row?.id_persona))
          .filter(Boolean)
      )
    ];

    if (!personaIds.length) return rows;

    const direccionesResult = await pool.query(
      `
        SELECT p.id_persona, d.direccion
        FROM personas p
        LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
        WHERE p.id_persona = ANY($1::int[])
      `,
      [personaIds]
    );

    const direccionByPersona = new Map(
      direccionesResult.rows.map((row) => [parsePositiveInt(row.id_persona), row.direccion ?? null])
    );

    return rows.map((row) => {
      const currentDireccion = row?.direccion ?? row?.texto_direccion ?? row?.direccion_texto;
      if (hasTextValue(currentDireccion)) return row;

      const personaId = parsePositiveInt(row?.id_persona);
      if (!personaId) return row;

      const fallbackDireccion = direccionByPersona.get(personaId);
      if (!hasTextValue(fallbackDireccion)) return row;

      return {
        ...row,
        direccion: fallbackDireccion,
        texto_direccion: row?.texto_direccion ?? fallbackDireccion
      };
    });
  },

  async findById(idEmpleado, capabilities, db = pool) {
    const fields = BASE_FIELDS.map((field) => `e.${field}`);
    if (capabilities.softDeleteField && !BASE_FIELDS.includes(capabilities.softDeleteField)) {
      fields.push(`e.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasCreatedBy) fields.push('e.created_by');
    if (capabilities.hasUpdatedBy) fields.push('e.updated_by');
    if (capabilities.hasTenantField && !BASE_FIELDS.includes('id_empresa')) fields.push('e.id_empresa');

    if (capabilities.hasPersonasTable) {
      fields.push('p.nombre AS persona_nombre');
      fields.push('p.apellido AS persona_apellido');
      fields.push('p.dni AS persona_dni');
      fields.push(`TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS persona_nombre_completo`);
      if (capabilities.hasPersonaTenantField) fields.push('p.id_empresa AS persona_id_empresa');
    }

    if (capabilities.hasSucursalesTable && capabilities.sucursalNameField) {
      fields.push(`s.${capabilities.sucursalNameField} AS sucursal_nombre`);
    }

    const joins = [];
    if (capabilities.hasPersonasTable) joins.push('LEFT JOIN personas p ON p.id_persona = e.id_persona');
    if (capabilities.hasSucursalesTable) joins.push('LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal');

    const joinsSql = joins.length ? `\n${joins.join('\n')}` : '';
    const query = `
      SELECT ${fields.join(', ')}
      FROM empleados e${joinsSql}
      WHERE e.id_empleado = $1
      LIMIT 1
    `;

    const result = await db.query(query, [idEmpleado]);
    return result.rows[0] || null;
  },

  async create(data, db = pool) {
    const result = await db.query(
      'SELECT empleados_crear($1::json) AS id_empleado',
      [JSON.stringify(data ?? {})]
    );
    return parsePositiveInt(result.rows[0]?.id_empleado);
  },

  async update(idEmpleado, data, db = pool) {
    await db.query(
      'SELECT empleados_actualizar($1, $2::json)',
      [idEmpleado, JSON.stringify(data ?? {})]
    );
  },

  async updateField(idEmpleado, campo, valor, db = pool) {
    await db.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      ['empleados', campo, String(valor), 'id_empleado', String(idEmpleado)]
    );
  },

  async hardDelete(idEmpleado, db = pool) {
    await db.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['empleados', 'id_empleado', String(idEmpleado)]
    );
  },

  async addAuditLog({ accion, descripcion, idUsuario, capabilities, db = pool }) {
    if (!capabilities.hasBitacorasTable || !idUsuario) return;
    await db.query(
      'INSERT INTO bitacoras (accion, descripcion, id_usuario) VALUES ($1, $2, $3)',
      [accion, descripcion, idUsuario]
    );
  },

  async personaExists(idPersona, db = pool) {
    const result = await db.query('SELECT 1 FROM personas WHERE id_persona = $1 LIMIT 1', [idPersona]);
    return result.rows.length > 0;
  },

  async sucursalExists(idSucursal, db = pool) {
    const result = await db.query('SELECT 1 FROM sucursales WHERE id_sucursal = $1 LIMIT 1', [idSucursal]);
    return result.rows.length > 0;
  },

  async cargoExists(idCargo, db = pool) {
    const result = await db.query(
      'SELECT 1 FROM cargos_empleados WHERE id_cargo = $1 AND COALESCE(estado, true) = true LIMIT 1',
      [idCargo]
    );
    return result.rows.length > 0;
  },

  async personaTenantEmpresa(idPersona, db = pool) {
    const result = await db.query(
      'SELECT id_empresa FROM personas WHERE id_persona = $1 LIMIT 1',
      [idPersona]
    );
    return result.rows[0]?.id_empresa ?? null;
  }
};

const empleadoService = {
  async listCargos(req) {
    const page = req.query.page === undefined ? 1 : parsePositiveInt(req.query.page);
    const requestedLimit = req.query.limit === undefined ? 500 : parsePositiveInt(req.query.limit);
    if (!page || !requestedLimit) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }
    const limit = Math.min(requestedLimit, 1000);
    const offset = (page - 1) * limit;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const estado = parseBooleanFilter(req.query.estado);
    if (req.query.estado !== undefined && estado === null) {
      return { status: 400, body: { error: true, message: 'El filtro estado debe ser booleano' } };
    }

    const where = [];
    const params = [];
    let idx = 1;
    if (q) {
      where.push(`COALESCE(c.nombre_cargo, '') ILIKE $${idx++}`);
      params.push(`%${q}%`);
    }
    if (estado !== null) {
      where.push(`c.estado = $${idx++}`);
      params.push(estado);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalResult = await pool.query(`SELECT COUNT(*)::int AS total FROM public.cargos_empleados c ${whereSql}`, params);
    params.push(limit, offset);
    const rowsResult = await pool.query(
      `SELECT c.id_cargo, c.nombre_cargo, c.descripcion, c.estado, c.fecha_creacion, c.fecha_actualizacion
       FROM public.cargos_empleados c
       ${whereSql}
       ORDER BY c.nombre_cargo ASC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    return {
      status: 200,
      body: {
        data: rowsResult.rows,
        cargos: rowsResult.rows,
        total: Number(totalResult.rows?.[0]?.total || 0),
        page,
        limit
      }
    };
  },

  async createCargo(req) {
    const nombreCargo = String(req.body?.nombre_cargo ?? '').trim();
    const descripcion = String(req.body?.descripcion ?? '').trim() || null;
    const estadoRaw = req.body?.estado;
    const estado = estadoRaw === undefined ? true : parseBooleanFilter(estadoRaw);

    if (!nombreCargo) {
      return { status: 400, body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'nombre_cargo es obligatorio.' }) };
    }
    if (estado === null) {
      return { status: 400, body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'estado debe ser booleano.' }) };
    }

    const result = await pool.query(
      `INSERT INTO public.cargos_empleados (nombre_cargo, descripcion, estado)
       VALUES ($1, $2, $3)
       ON CONFLICT ((LOWER(TRIM(nombre_cargo))))
       DO UPDATE SET
         nombre_cargo = EXCLUDED.nombre_cargo,
         descripcion = COALESCE(EXCLUDED.descripcion, public.cargos_empleados.descripcion),
         estado = EXCLUDED.estado,
         fecha_actualizacion = NOW()
       RETURNING id_cargo, nombre_cargo, descripcion, estado, fecha_creacion, fecha_actualizacion`,
      [nombreCargo, descripcion, estado]
    );

    return { status: 201, body: { ok: true, error: false, data: result.rows[0] } };
  },

  async updateCargo(req) {
    const idCargo = parsePositiveInt(req.params.id);
    if (!idCargo) {
      return { status: 400, body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El id debe ser un entero positivo' }) };
    }

    const payload = isPlainObject(req.body) ? req.body : {};
    const updates = [];
    const params = [];
    let idx = 1;

    if (hasOwn(payload, 'nombre_cargo')) {
      const nombreCargo = String(payload.nombre_cargo ?? '').trim();
      if (!nombreCargo) {
        return { status: 400, body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'nombre_cargo no puede estar vacio.' }) };
      }
      updates.push(`nombre_cargo = $${idx++}`);
      params.push(nombreCargo);
    }
    if (hasOwn(payload, 'descripcion')) {
      const descripcion = String(payload.descripcion ?? '').trim();
      updates.push(`descripcion = $${idx++}`);
      params.push(descripcion || null);
    }
    if (hasOwn(payload, 'estado')) {
      const estado = parseBooleanFilter(payload.estado);
      if (estado === null) {
        return { status: 400, body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'estado debe ser booleano.' }) };
      }
      updates.push(`estado = $${idx++}`);
      params.push(estado);
    }

    if (!updates.length) {
      return { status: 400, body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'No hay cambios para actualizar.' }) };
    }

    updates.push('fecha_actualizacion = NOW()');
    params.push(idCargo);
    const query = `
      UPDATE public.cargos_empleados
      SET ${updates.join(', ')}
      WHERE id_cargo = $${idx}
      RETURNING id_cargo, nombre_cargo, descripcion, estado, fecha_creacion, fecha_actualizacion
    `;
    const result = await pool.query(query, params);
    if (!result.rows.length) {
      return { status: 404, body: buildErrorBody({ code: 'NOT_FOUND', message: 'Cargo no encontrado.' }) };
    }
    return { status: 200, body: { ok: true, error: false, data: result.rows[0] } };
  },

  async list(req) {
    const capabilities = await getSchemaCapabilities();
    const page = req.query.page === undefined ? 1 : parsePositiveInt(req.query.page);
    const requestedLimit = req.query.limit === undefined ? 10 : parsePositiveInt(req.query.limit);

    if (!page || !requestedLimit) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const searchName = typeof req.query.nombre === 'string' ? req.query.nombre.trim() : '';
    const effectiveSearch = search || searchQuery || searchName;
    const estado = parseBooleanFilter(req.query.estado);
    const idSucursal = req.query.id_sucursal === undefined ? null : parsePositiveInt(req.query.id_sucursal);

    if (req.query.estado !== undefined && estado === null) {
      return { status: 400, body: { error: true, message: 'El filtro estado debe ser booleano' } };
    }

    if (req.query.id_sucursal !== undefined && !idSucursal) {
      return { status: 400, body: { error: true, message: 'El filtro id_sucursal debe ser entero positivo' } };
    }

    if (req.query.estado !== undefined && !capabilities.softDeleteField) {
      return {
        status: 400,
        body: { error: true, message: 'La tabla empleados no soporta filtro por estado' }
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    const { data: pagedRows, total } = await empleadoRepository.searchWithPagination({
      capabilities,
      page,
      limit,
      searchTerm: effectiveSearch,
      estado,
      idSucursal,
      tenantId
    });
    const data = (await empleadoRepository.backfillDirecciones(pagedRows, capabilities)).map(mapEmpleadoListRow);

    return {
      status: 200,
      body: {
        data,
        total,
        page,
        limit
      }
    };
  },

  async getById(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpleado = parsePositiveInt(req.params.id);

    if (!idEmpleado) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const empleado = await empleadoRepository.findById(idEmpleado, capabilities);
    if (!empleado) {
      return { status: 404, body: { error: true, message: 'Empleado no encontrado' } };
    }

    if (capabilities.softDeleteField && empleado[capabilities.softDeleteField] === false) {
      return { status: 404, body: { error: true, message: 'Empleado no encontrado' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== empleado.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este empleado' } };
    }

    if (
      tenantId &&
      !capabilities.hasTenantField &&
      capabilities.hasPersonasTable &&
      capabilities.hasPersonaTenantField &&
      tenantId !== parsePositiveInt(empleado.persona_id_empresa)
    ) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este empleado' } };
    }

    const detailedEmpleado = await empleadoRepository.findDetailById(idEmpleado);
    const responsePayload = mapEmpleadoListRow(detailedEmpleado ? { ...empleado, ...detailedEmpleado } : empleado);
    const [enrichedPayload] = await empleadoRepository.backfillDirecciones([responsePayload], capabilities);

    return { status: 200, body: enrichedPayload };
  },

  async create(req) {
    const capabilities = await getSchemaCapabilities();
    const payload = req.body;

    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'Debe enviar un objeto con datos validos.' })
      };
    }

    const allowedFields = new Set([...FUNCTION_UPDATE_FIELDS, 'id_empresa', 'created_by', 'updated_by']);
    const unknownFields = unknownFieldsFromPayload(payload, allowedFields);
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

    const validationErrors = validateEmpleadoPayload(payload, { requirePersona: true, requireSucursal: true, requireCargo: true });
    if (validationErrors.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: validationErrors[0].message,
          details: { field: validationErrors[0].field }
        })
      };
    }

    const insertData = { ...payload };
    if (hasOwn(insertData, 'cargo')) {
      insertData.cargo = String(insertData.cargo ?? '').trim();
    }
    const idUsuario = resolveUserId(req);
    const tenantId = parsePositiveInt(req.user?.id_empresa);

    if (capabilities.hasTenantField && tenantId) {
      const requestedTenantId = parsePositiveInt(insertData.id_empresa);
      if (requestedTenantId && requestedTenantId !== tenantId) {
        return {
          status: 403,
          body: buildErrorBody({ code: 'FORBIDDEN', message: 'No puede crear empleados para otra empresa.' })
        };
      }
      if (!requestedTenantId) {
        insertData.id_empresa = tenantId;
      }
    }

    const idPersona = parsePositiveInt(insertData.id_persona);
    const idSucursal = parsePositiveInt(insertData.id_sucursal);
    if (!idPersona || !(await empleadoRepository.personaExists(idPersona))) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'La persona seleccionada no existe.' })
      };
    }

    if (!idSucursal || !(await empleadoRepository.sucursalExists(idSucursal))) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'La sucursal seleccionada no existe.' })
      };
    }

    const idCargo = parsePositiveInt(insertData.id_cargo);
    if (idCargo && !(await empleadoRepository.cargoExists(idCargo))) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'El cargo seleccionado no existe o esta inactivo.' })
      };
    }

    if (tenantId && capabilities.hasPersonaTenantField) {
      const personaTenant = parsePositiveInt(await empleadoRepository.personaTenantEmpresa(idPersona));
      if (personaTenant && personaTenant !== tenantId) {
        return {
          status: 403,
          body: buildErrorBody({ code: 'FORBIDDEN', message: 'No puede vincular personas de otra empresa.' })
        };
      }
    }

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const idEmpleado = await empleadoRepository.create(insertData, client);
      if (!idEmpleado) {
        const error = new Error('No se pudo obtener el id del empleado creado');
        error.httpStatus = 500;
        throw error;
      }

      if (capabilities.hasTenantField && insertData.id_empresa !== undefined) {
        await empleadoRepository.updateField(idEmpleado, 'id_empresa', insertData.id_empresa, client);
      }
      if (capabilities.hasCreatedBy && idUsuario) {
        await empleadoRepository.updateField(idEmpleado, 'created_by', idUsuario, client);
      }
      if (capabilities.hasUpdatedBy && idUsuario) {
        await empleadoRepository.updateField(idEmpleado, 'updated_by', idUsuario, client);
      }
      await empleadoRepository.addAuditLog({
        accion: 'EMPLEADO_CREAR',
        descripcion: `Empleado creado: persona ${payload.id_persona ?? 'sin_persona'}`,
        idUsuario,
        capabilities,
        db: client
      });

      await client.query('COMMIT');
      return { status: 201, body: { ok: true, error: false, message: 'Empleado creado exitosamente.' } };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  },

  async update(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpleado = parsePositiveInt(req.params.id);

    if (!idEmpleado) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El id debe ser un entero positivo.' })
      };
    }

    const legacyPayload = normalizeLegacyUpdatePayload(req.body);
    const rawPayload = legacyPayload || req.body;

    if (!isPlainObject(rawPayload) || Object.keys(rawPayload).length === 0) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Debe enviar un objeto JSON con campos para actualizar.'
        })
      };
    }

    const allowedFields = new Set(FUNCTION_UPDATE_FIELDS);
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');
    if (capabilities.hasTenantField) allowedFields.add('id_empresa');

    const payload = Object.fromEntries(
      Object.entries(rawPayload).filter(([campo, valor]) => campo && valor !== undefined)
    );
    if (hasOwn(payload, 'cargo')) {
      payload.cargo = String(payload.cargo ?? '').trim();
    }

    const unknownFields = unknownFieldsFromPayload(payload, allowedFields);
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

    if (!Object.keys(payload).length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Debe enviar al menos un campo valido para actualizar.'
        })
      };
    }

    const invalidFields = Object.keys(payload).filter((campo) => !allowedFields.has(campo));
    if (invalidFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: `Campos no validos para actualizacion: ${invalidFields.join(', ')}`
        })
      };
    }

    const validationErrors = validateEmpleadoPayload(payload, {
      requirePersona: false,
      requireSucursal: false
    });
    if (validationErrors.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: validationErrors[0].message,
          details: { field: validationErrors[0].field }
        })
      };
    }

    const current = await empleadoRepository.findById(idEmpleado, capabilities);
    if (!current) {
      return { status: 404, body: buildErrorBody({ code: 'NOT_FOUND', message: 'Empleado no encontrado.' }) };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado para este empleado.' }) };
    }

    if (
      tenantId &&
      !capabilities.hasTenantField &&
      capabilities.hasPersonasTable &&
      capabilities.hasPersonaTenantField &&
      tenantId !== parsePositiveInt(current.persona_id_empresa)
    ) {
      return { status: 403, body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado para este empleado.' }) };
    }

    if (
      hasOwn(payload, 'id_empresa') &&
      capabilities.hasTenantField &&
      tenantId &&
      parsePositiveInt(payload.id_empresa) !== tenantId
    ) {
      return { status: 403, body: buildErrorBody({ code: 'FORBIDDEN', message: 'No puede mover empleados a otra empresa.' }) };
    }

    if (hasOwn(payload, 'id_persona')) {
      const nextPersonaId = parsePositiveInt(payload.id_persona);
      if (!nextPersonaId || !(await empleadoRepository.personaExists(nextPersonaId))) {
        return {
          status: 404,
          body: buildErrorBody({ code: 'NOT_FOUND', message: 'La persona seleccionada no existe.' })
        };
      }
      if (tenantId && capabilities.hasPersonaTenantField) {
        const personaTenant = parsePositiveInt(await empleadoRepository.personaTenantEmpresa(nextPersonaId));
        if (personaTenant && personaTenant !== tenantId) {
          return {
            status: 403,
            body: buildErrorBody({ code: 'FORBIDDEN', message: 'No puede vincular personas de otra empresa.' })
          };
        }
      }
    }

    if (hasOwn(payload, 'id_sucursal')) {
      const nextSucursalId = parsePositiveInt(payload.id_sucursal);
      if (!nextSucursalId || !(await empleadoRepository.sucursalExists(nextSucursalId))) {
        return {
          status: 404,
          body: buildErrorBody({ code: 'NOT_FOUND', message: 'La sucursal seleccionada no existe.' })
        };
      }
    }

    if (hasOwn(payload, 'id_cargo')) {
      const nextCargoId = parsePositiveInt(payload.id_cargo);
      if (!nextCargoId || !(await empleadoRepository.cargoExists(nextCargoId))) {
        return {
          status: 404,
          body: buildErrorBody({ code: 'NOT_FOUND', message: 'El cargo seleccionado no existe o esta inactivo.' })
        };
      }
    }

    const functionPayload = {};
    const fallbackFieldUpdates = [];

    for (const [campo, valor] of Object.entries(payload)) {
      if (FUNCTION_UPDATE_FIELDS.has(campo)) {
        functionPayload[campo] = valor;
      } else {
        fallbackFieldUpdates.push([campo, valor]);
      }
    }

    const idUsuario = resolveUserId(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (Object.keys(functionPayload).length > 0) {
        await empleadoRepository.update(idEmpleado, functionPayload, client);
      }

      for (const [campo, valor] of fallbackFieldUpdates) {
        await empleadoRepository.updateField(idEmpleado, campo, valor, client);
      }

      if (capabilities.hasUpdatedBy && idUsuario && !hasOwn(payload, 'updated_by')) {
        await empleadoRepository.updateField(idEmpleado, 'updated_by', idUsuario, client);
      }

      const changedFields = Object.keys(payload).join(', ');
      await empleadoRepository.addAuditLog({
        accion: 'EMPLEADO_ACTUALIZAR',
        descripcion: `Empleado ${idEmpleado} actualizado: campos ${changedFields}`,
        idUsuario,
        capabilities,
        db: client
      });

      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }

    return {
      status: 200,
      body: { ok: true, error: false, message: 'Empleado actualizado correctamente' }
    };
  },

  async remove(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpleado = parsePositiveInt(req.params.id);

    if (!idEmpleado) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'El id debe ser un entero positivo.'
        })
      };
    }

    const current = await empleadoRepository.findById(idEmpleado, capabilities);
    if (!current) {
      return {
        status: 404,
        body: buildErrorBody({
          code: 'NOT_FOUND',
          message: 'Empleado no encontrado.'
        })
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return {
        status: 403,
        body: buildErrorBody({
          code: 'FORBIDDEN',
          message: 'Acceso denegado para este empleado.'
        })
      };
    }

    if (
      tenantId &&
      !capabilities.hasTenantField &&
      capabilities.hasPersonasTable &&
      capabilities.hasPersonaTenantField &&
      tenantId !== parsePositiveInt(current.persona_id_empresa)
    ) {
      return {
        status: 403,
        body: buildErrorBody({
          code: 'FORBIDDEN',
          message: 'Acceso denegado para este empleado.'
        })
      };
    }

    const idUsuario = resolveUserId(req);
    const client = await pool.connect();
    let message = 'Empleado eliminado correctamente';

    try {
      await client.query('BEGIN');

      if (capabilities.softDeleteField) {
        await empleadoRepository.updateField(idEmpleado, capabilities.softDeleteField, false, client);
        if (capabilities.hasUpdatedBy && idUsuario) {
          await empleadoRepository.updateField(idEmpleado, 'updated_by', idUsuario, client);
        }
        message = 'Empleado inactivado correctamente';
      } else {
        await empleadoRepository.hardDelete(idEmpleado, client);
      }

      await empleadoRepository.addAuditLog({
        accion: 'EMPLEADO_ELIMINAR',
        descripcion: `Empleado ${idEmpleado} eliminado. Modo: ${capabilities.softDeleteField ? 'soft' : 'hard'}`,
        idUsuario,
        capabilities,
        db: client
      });

      await client.query('COMMIT');
      return { status: 200, body: { ok: true, error: false, message } };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    const result = await handler(req, res);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Empleados API error:', err.message);
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
    return res.status(500).json(
      buildErrorBody({
        code: 'INTERNAL_ERROR',
        message: 'No se pudo procesar la solicitud de empleados.'
      })
    );
  }
};

/* =======================
   GET - LISTAR EMPLEADOS
======================= */
router.get('/empleados-detalle', checkPermission(EMPLEADOS_LIST_PERMISSIONS), asyncHandler(empleadoService.list));
router.get('/empleados', checkPermission(EMPLEADOS_LIST_PERMISSIONS), asyncHandler(empleadoService.list));
router.get('/empleados/cargos', checkPermission(EMPLEADOS_LIST_PERMISSIONS), asyncHandler(empleadoService.listCargos));
router.post('/empleados/cargos', checkPermission(EMPLEADOS_CREATE_PERMISSIONS), asyncHandler(empleadoService.createCargo));
router.put('/empleados/cargos/:id', checkPermission(EMPLEADOS_EDIT_PERMISSIONS), asyncHandler(empleadoService.updateCargo));

/* =======================
   GET - EMPLEADO POR ID
======================= */
router.get('/empleados/:id', checkPermission(EMPLEADOS_DETAIL_PERMISSIONS), asyncHandler(empleadoService.getById));

/* =======================
   POST - INSERTAR
======================= */
router.post('/empleados', checkPermission(EMPLEADOS_CREATE_PERMISSIONS), asyncHandler(empleadoService.create));

/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/empleados/:id', checkPermission(EMPLEADOS_EDIT_PERMISSIONS), asyncHandler(empleadoService.update));

/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/empleados/:id', checkPermission(EMPLEADOS_DELETE_PERMISSIONS), asyncHandler(empleadoService.remove));

export default router;
