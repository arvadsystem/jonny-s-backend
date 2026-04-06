import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import {
  normalizeEmpleadoAtomicPayload,
  normalizeClienteAtomicPayload,
  resolveOrCreatePersona,
  resolveOrCreateEmpresa
} from '../services/entityComposer.js';
import {
  buildErrorBody,
  mapDbErrorToSafe,
  unknownFieldsFromPayload,
  sanitizeApiErrorMessage,
  isValidDateOnly,
  isFutureDateOnly
} from '../utils/security/personasHardening.js';

const router = express.Router();

const EMPLEADOS_CREATE_PERMISSIONS = ['EMPLEADOS_CREAR'];
const CLIENTES_CREATE_PERMISSIONS = ['CLIENTES_CREAR'];
const EMPLEADO_ATOMIC_ALLOWED_FIELDS = new Set([
  'fecha_ingreso',
  'salario_base',
  'estado',
  'id_sucursal',
  'id_persona',
  'cargo',
  'nombre_referencia',
  'telefono_referencia',
  'id_empresa'
]);
const CLIENTE_ATOMIC_ALLOWED_FIELDS = new Set([
  'fecha_ingreso',
  'puntos',
  'id_tipo_cliente',
  'id_persona',
  'id_empresa',
  'id_sucursal',
  'estado',
  'origen'
]);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parsePositiveNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseBooleanValue = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 't', 'si', 'activo'].includes(normalized)) return true;
  if (['false', '0', 'f', 'no', 'inactivo'].includes(normalized)) return false;
  return null;
};

const toTrimmedText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const rollbackQuietly = async (client) => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // noop: preserve original error
  }
};

const mapDbError = (err) => {
  return mapDbErrorToSafe(err, {
    defaultMessage: 'No se pudo procesar la solicitud atomica.'
  });
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

    const mapped = mapDbError(err);
    if (mapped) {
      return res.status(mapped.status).json(
        buildErrorBody({ code: mapped.code, message: mapped.message })
      );
    }

    console.error('Personas atomic API error:', err.message);
    return res.status(500).json(
      buildErrorBody({
        code: 'INTERNAL_ERROR',
        message: 'No se pudo procesar la solicitud atomica.'
      })
    );
  }
};

const buildAtomicSuccessData = ({ entidadTipo, entidad, idPrincipal, idPersona = null, idEmpresa = null, personaCreada = false, empresaCreada = false }) => ({
  entidad_tipo: entidadTipo,
  entidad: entidad || null,
  id_principal: idPrincipal ?? null,
  id_persona: idPersona,
  id_empresa: idEmpresa,
  persona_creada: Boolean(personaCreada),
  empresa_creada: Boolean(empresaCreada)
});

const findEmpleadoDetail = async (client, idEmpleado) => {
  try {
    const rs = await client.query('SELECT * FROM empleados_listar() WHERE id_empleado = $1 LIMIT 1', [idEmpleado]);
    return rs.rows?.[0] || null;
  } catch {
    const rs = await client.query(
      `
        SELECT
          e.id_empleado,
          e.id_persona,
          e.id_sucursal,
          e.fecha_ingreso,
          e.salario_base,
          e.estado,
          e.cargo,
          e.nombre_referencia,
          e.telefono_referencia,
          TRIM(COALESCE(p.nombre, '') || ' ' || COALESCE(p.apellido, '')) AS nombre_completo,
          p.dni,
          t.telefono,
          c.direccion_correo AS correo,
          d.direccion,
          s.nombre_sucursal AS sucursal
        FROM empleados e
        LEFT JOIN personas p ON p.id_persona = e.id_persona
        LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
        LEFT JOIN correos c ON c.id_correo = p.id_correo
        LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
        LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
        WHERE e.id_empleado = $1
        LIMIT 1
      `,
      [idEmpleado]
    );
    return rs.rows?.[0] || null;
  }
};

const findClienteDetail = async (client, idCliente) => {
  const rs = await client.query(
    `
      SELECT
        c.id_cliente,
        c.id_persona,
        c.id_empresa,
        c.id_sucursal,
        c.id_tipo_cliente,
        c.fecha_ingreso,
        c.puntos,
        c.estado,
        TRIM(COALESCE(p.nombre, '') || ' ' || COALESCE(p.apellido, '')) AS persona_nombre_completo,
        p.dni AS persona_dni,
        e.nombre_empresa,
        e.rtn AS empresa_rtn,
        tc.descripcion AS tipo_cliente
      FROM clientes c
      LEFT JOIN personas p ON p.id_persona = c.id_persona
      LEFT JOIN empresas e ON e.id_empresa = c.id_empresa
      LEFT JOIN tipo_cliente tc ON tc.id_tipo_cliente = c.id_tipo_cliente
      WHERE c.id_cliente = $1
      LIMIT 1
    `,
    [idCliente]
  );

  return rs.rows?.[0] || null;
};

const trySetClienteSucursal = async (client, idCliente, idSucursal) => {
  const parsedCliente = parsePositiveInt(idCliente);
  const parsedSucursal = parsePositiveInt(idSucursal);
  if (!parsedCliente || !parsedSucursal) return;
  try {
    await client.query(
      'UPDATE clientes SET id_sucursal = $1 WHERE id_cliente = $2',
      [parsedSucursal, parsedCliente]
    );
  } catch (error) {
    if (error?.code === '42703') return;
    throw error;
  }
};

const atomicService = {
  async createEmpleado(req) {
    const body = isPlainObject(req.body) ? req.body : {};
    const empleadoPayload = isPlainObject(body.empleado) ? body.empleado : { ...body };
    delete empleadoPayload.persona;
    delete empleadoPayload.empresa;
    delete empleadoPayload.cliente;

    if (!isPlainObject(empleadoPayload)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Payload invalido para crear empleado atomico.'
        })
      };
    }

    const unknownFields = unknownFieldsFromPayload(empleadoPayload, EMPLEADO_ATOMIC_ALLOWED_FIELDS);
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

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { idPersona, created: personaCreada } = await resolveOrCreatePersona({
        client,
        req,
        idPersona: body.id_persona ?? empleadoPayload.id_persona,
        personaPayload: body.persona,
        allowClientesContext: false
      });

      const normalizedEmpleado = normalizeEmpleadoAtomicPayload({
        ...empleadoPayload,
        id_persona: idPersona
      });

      if (!normalizedEmpleado.id_persona || !normalizedEmpleado.id_sucursal) {
        const error = new Error('Empleado atomico requiere id_persona e id_sucursal validos');
        error.httpStatus = 400;
        throw error;
      }

      if (Object.prototype.hasOwnProperty.call(empleadoPayload, 'salario_base')) {
        const salarioBase = Number(empleadoPayload.salario_base);
        if (!Number.isFinite(salarioBase) || salarioBase < 0) {
          const error = new Error('salario_base debe ser un numero mayor a 0');
          error.httpStatus = 400;
          throw error;
        }
      }

      if (Object.prototype.hasOwnProperty.call(empleadoPayload, 'fecha_ingreso')) {
        const fecha = toTrimmedText(empleadoPayload.fecha_ingreso);
        if (fecha && (!isValidDateOnly(fecha) || isFutureDateOnly(fecha))) {
          const error = new Error('fecha_ingreso invalida');
          error.httpStatus = 400;
          throw error;
        }
      }

      if (Object.prototype.hasOwnProperty.call(empleadoPayload, 'estado')) {
        const parsedEstado = parseBooleanValue(empleadoPayload.estado);
        if (parsedEstado === null) {
          const error = new Error('estado de empleado debe ser booleano');
          error.httpStatus = 400;
          throw error;
        }
      }

      const createResult = await client.query('SELECT empleados_crear($1::json) AS id_empleado', [
        JSON.stringify(normalizedEmpleado)
      ]);

      const idEmpleado = parsePositiveInt(createResult.rows?.[0]?.id_empleado);
      if (!idEmpleado) {
        const error = new Error('No se pudo crear empleado en flujo atomico');
        error.httpStatus = 500;
        throw error;
      }

      const empleado = await findEmpleadoDetail(client, idEmpleado);

      await client.query('COMMIT');

      return {
        status: 201,
        body: {
          ok: true,
          error: false,
          message: 'Empleado creado en flujo atomico',
          data: {
            ...buildAtomicSuccessData({
              entidadTipo: 'empleado',
              entidad: empleado,
              idPrincipal: idEmpleado,
              idPersona,
              personaCreada,
              empresaCreada: false
            }),
            id_empleado: idEmpleado,
            empleado
          }
        }
      };
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  },

  async createCliente(req) {
    const body = isPlainObject(req.body) ? req.body : {};
    const clientePayload = isPlainObject(body.cliente) ? body.cliente : { ...body };
    delete clientePayload.persona;
    delete clientePayload.empresa;
    delete clientePayload.empleado;

    if (!isPlainObject(clientePayload)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Payload invalido para crear cliente atomico.'
        })
      };
    }

    const unknownFields = unknownFieldsFromPayload(clientePayload, CLIENTE_ATOMIC_ALLOWED_FIELDS);
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

    const origenRaw = String(body.origen ?? clientePayload.origen ?? '').trim().toLowerCase();
    const origen = origenRaw === 'empresa' ? 'empresa' : origenRaw === 'persona' ? 'persona' : null;

    if (!origen) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'origen debe ser "persona" o "empresa".'
        })
      };
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      let idPersona = parsePositiveInt(body.id_persona ?? clientePayload.id_persona);
      let idEmpresa = parsePositiveInt(body.id_empresa ?? clientePayload.id_empresa);
      let personaCreada = false;
      let empresaCreada = false;

      if (origen === 'empresa') {
        const empresaResult = await resolveOrCreateEmpresa({
          client,
          req,
          idEmpresa,
          empresaPayload: body.empresa,
          allowClientesContext: true
        });
        idEmpresa = empresaResult.idEmpresa;
        empresaCreada = empresaResult.created;
        idPersona = null;
      } else {
        const personaResult = await resolveOrCreatePersona({
          client,
          req,
          idPersona,
          personaPayload: body.persona,
          allowClientesContext: true
        });
        idPersona = personaResult.idPersona;
        personaCreada = personaResult.created;
        idEmpresa = null;
      }

      const normalizedCliente = normalizeClienteAtomicPayload({
        ...clientePayload,
        id_persona: idPersona,
        id_empresa: idEmpresa
      });

      const idTipoCliente = parsePositiveInt(normalizedCliente.id_tipo_cliente);
      if (!idTipoCliente) {
        const error = new Error('id_tipo_cliente es requerido y debe ser entero positivo');
        error.httpStatus = 400;
        throw error;
      }

      if (Object.prototype.hasOwnProperty.call(clientePayload, 'puntos')) {
        const rawPuntos = Number(clientePayload.puntos);
        if (!Number.isFinite(rawPuntos) || rawPuntos < 0) {
          const error = new Error('puntos debe ser un numero mayor o igual a 0');
          error.httpStatus = 400;
          throw error;
        }
      }

      if (Object.prototype.hasOwnProperty.call(clientePayload, 'fecha_ingreso')) {
        const fechaIngreso = toTrimmedText(clientePayload.fecha_ingreso);
        if (fechaIngreso && (!isValidDateOnly(fechaIngreso) || isFutureDateOnly(fechaIngreso))) {
          const error = new Error('fecha_ingreso invalida');
          error.httpStatus = 400;
          throw error;
        }
      }

      if (Object.prototype.hasOwnProperty.call(clientePayload, 'estado')) {
        const parsedEstado = parseBooleanValue(clientePayload.estado);
        if (parsedEstado === null) {
          const error = new Error('estado de cliente debe ser booleano');
          error.httpStatus = 400;
          throw error;
        }
      }

      if ((normalizedCliente.id_persona ? 1 : 0) + (normalizedCliente.id_empresa ? 1 : 0) !== 1) {
        const error = new Error('Cliente atomico requiere exactamente una relacion: persona o empresa');
        error.httpStatus = 400;
        throw error;
      }

      const createResult = await client.query('SELECT fn_guardar_cliente($1::json) AS id_cliente', [
        JSON.stringify(normalizedCliente)
      ]);

      const idCliente = parsePositiveInt(createResult.rows?.[0]?.id_cliente);
      if (!idCliente) {
        const error = new Error('No se pudo crear cliente en flujo atomico');
        error.httpStatus = 500;
        throw error;
      }

      await trySetClienteSucursal(client, idCliente, normalizedCliente.id_sucursal);

      const cliente = await findClienteDetail(client, idCliente);

      await client.query('COMMIT');

      return {
        status: 201,
        body: {
          ok: true,
          error: false,
          message: 'Cliente creado en flujo atomico',
          data: {
            ...buildAtomicSuccessData({
              entidadTipo: 'cliente',
              entidad: cliente,
              idPrincipal: idCliente,
              idPersona: normalizedCliente.id_persona ?? null,
              idEmpresa: normalizedCliente.id_empresa ?? null,
              personaCreada,
              empresaCreada
            }),
            id_cliente: idCliente,
            cliente
          }
        }
      };
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  }
};

router.post('/empleados/atomico', checkPermission(EMPLEADOS_CREATE_PERMISSIONS), asyncHandler(atomicService.createEmpleado));
router.post('/clientes/atomico', checkPermission(CLIENTES_CREATE_PERMISSIONS), asyncHandler(atomicService.createCliente));

export default router;
