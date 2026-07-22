import pool from '../config/db-connection.js';
import { readRequestAccess } from '../middleware/checkPermission.js';
import {
  getWarehouseAssignmentDetails,
  resolveCatalogoMaestroEntity
} from './catalogoMaestroAsignacionesService.js';
import {
  SolicitudesCompraError,
  parsePositiveIntStrict,
  parseQuantity
} from './solicitudesCompraService.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_LINES = 100;
const MAX_COMMENT_LENGTH = 1000;
const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'ADMINISTRADOR']);
const APPROVAL_FIELDS = new Set(['comentario_revision', 'detalles']);
const APPROVAL_DETAIL_FIELDS = new Set(['id_solicitud_detalle', 'cantidad_aprobada', 'id_proveedor']);
const REJECTION_FIELDS = new Set(['comentario_revision']);

const fail = (status, code, message) => {
  throw new SolicitudesCompraError(status, code, message);
};

const normalizeRole = (value) => String(value ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase();
const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';

const ensurePlainObject = (value, message) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'VALIDATION_ERROR', message);
};

const rejectUnexpectedFields = (value, allowed, context) => {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail(400, 'VALIDATION_ERROR', `${context} contiene campos no permitidos: ${unexpected.join(', ')}.`);
  }
};

const normalizeComment = (value, { required = false } = {}) => {
  if (!hasValue(value)) {
    if (required) fail(400, 'VALIDATION_ERROR', 'comentario_revision es obligatorio.');
    return null;
  }
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized && required) fail(400, 'VALIDATION_ERROR', 'comentario_revision es obligatorio.');
  if (normalized.length > MAX_COMMENT_LENGTH) {
    fail(400, 'VALIDATION_ERROR', `comentario_revision no puede exceder ${MAX_COMMENT_LENGTH} caracteres.`);
  }
  return normalized || null;
};

const parsePagination = (query) => {
  const page = hasValue(query?.page) ? parsePositiveIntStrict(query.page) : 1;
  const requestedLimit = hasValue(query?.limit) ? parsePositiveIntStrict(query.limit) : DEFAULT_LIMIT;
  if (!page || !requestedLimit) fail(400, 'VALIDATION_ERROR', 'page y limit deben ser enteros positivos.');
  const limit = Math.min(requestedLimit, MAX_LIMIT);
  return { page, limit, offset: (page - 1) * limit };
};

const assertAdministrativeAccess = async (req, queryRunner, readAccess) => {
  const access = await readAccess(req, queryRunner);
  if (!access?.idUsuario) fail(401, 'UNAUTHORIZED', 'No autorizado.');
  const roles = new Set(Array.from(access.roles || []).map(normalizeRole));
  const isAdministrative = Boolean(access.isSuperAdmin) || Array.from(roles).some((role) => ADMIN_ROLES.has(role));
  if (!isAdministrative) fail(403, 'FORBIDDEN', 'Solo un administrador puede revisar solicitudes de compra.');
  return { idUsuario: Number(access.idUsuario), isSuperAdmin: Boolean(access.isSuperAdmin), roles };
};

const validateApprovalPayload = (body) => {
  ensurePlainObject(body, 'El payload debe ser un objeto.');
  rejectUnexpectedFields(body, APPROVAL_FIELDS, 'El payload');
  if (!Array.isArray(body.detalles) || body.detalles.length === 0) {
    fail(400, 'VALIDATION_ERROR', 'detalles debe contener todas las lineas de la solicitud.');
  }
  if (body.detalles.length > MAX_LINES) fail(400, 'VALIDATION_ERROR', `No se permiten mas de ${MAX_LINES} lineas.`);
  const seenIds = new Set();
  const parsedDetails = body.detalles.map((detail) => {
    ensurePlainObject(detail, 'Cada detalle debe ser un objeto.');
    rejectUnexpectedFields(detail, APPROVAL_DETAIL_FIELDS, 'El detalle');
    const id = parsePositiveIntStrict(detail.id_solicitud_detalle);
    const providerId = parsePositiveIntStrict(detail.id_proveedor);
    if (!id) fail(400, 'VALIDATION_ERROR', 'id_solicitud_detalle debe ser un entero positivo.');
    if (seenIds.has(id)) fail(400, 'VALIDATION_ERROR', 'No se permiten IDs de detalle duplicados.');
    if (!providerId) fail(400, 'VALIDATION_ERROR', 'id_proveedor es obligatorio y debe ser un entero positivo.');
    if (!hasValue(detail.cantidad_aprobada)) fail(400, 'VALIDATION_ERROR', 'cantidad_aprobada es obligatoria.');
    seenIds.add(id);
    return { id_solicitud_detalle: id, id_proveedor: providerId, rawQuantity: detail.cantidad_aprobada };
  });
  return { comment: normalizeComment(body.comentario_revision), details: parsedDetails };
};

const parseUnsignedDecimal = (value) => {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const digits = BigInt(`${whole}${fraction}`);
  return digits > 0n ? { digits, scale: fraction.length } : null;
};

const powerOfTen = (exponent) => 10n ** BigInt(exponent);

const formatScaled4 = (scaled) => {
  const integer = scaled / 10_000n;
  const fraction = String(scaled % 10_000n).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : String(integer);
};

export const multiplyApprovedQuantityToBase = (quantity, factor) => {
  const left = parseUnsignedDecimal(quantity);
  const right = parseUnsignedDecimal(factor);
  if (!left || !right) fail(409, 'CONFLICT', 'El factor de conversion snapshot no es valido.');
  const product = left.digits * right.digits;
  const sourceScale = left.scale + right.scale;
  let scaled4;
  if (sourceScale <= 4) {
    scaled4 = product * powerOfTen(4 - sourceScale);
  } else {
    const divisor = powerOfTen(sourceScale - 4);
    scaled4 = product / divisor;
    const remainder = product % divisor;
    if (remainder * 2n >= divisor) scaled4 += 1n;
  }
  if (scaled4 <= 0n) fail(409, 'CONFLICT', 'La cantidad base aprobada no es valida.');
  return formatScaled4(scaled4);
};

const mapDatabaseError = (error) => {
  if (error instanceof SolicitudesCompraError) return error;
  if (['23502', '23503', '23514', '22P02', '22003'].includes(error?.code)) {
    return new SolicitudesCompraError(400, 'VALIDATION_ERROR', 'Los datos de revision no son validos.');
  }
  if (error?.code === '23505') return new SolicitudesCompraError(409, 'CONFLICT', 'La revision entra en conflicto con datos existentes.');
  return new SolicitudesCompraError(500, 'INTERNAL_ERROR', 'No se pudo completar la revision solicitada.');
};

const rollbackQuietly = async (client) => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // AM: conserva el error original de la transaccion.
  }
};

const assertPendingHeader = (header) => {
  if (!header) fail(404, 'NOT_FOUND', 'Solicitud de compra no encontrada.');
  if (String(header.estado || '').trim().toUpperCase() !== 'PENDIENTE') {
    fail(409, 'INVALID_STATE', 'La solicitud ya no se encuentra en estado PENDIENTE.');
  }
  if (header.inventario_aplicado === true) {
    fail(409, 'CONFLICT', 'La solicitud ya tiene inventario aplicado.');
  }
};

export const createSolicitudesCompraRevisionService = (overrides = {}) => {
  const dependencies = {
    db: overrides.db || pool,
    readAccess: overrides.readAccess || readRequestAccess,
    resolveMaster: overrides.resolveMaster || resolveCatalogoMaestroEntity,
    getAssignment: overrides.getAssignment || getWarehouseAssignmentDetails
  };

  const listProviders = async (req) => {
    await assertAdministrativeAccess(req, dependencies.db, dependencies.readAccess);
    const pagination = parsePagination(req.query);
    const search = hasValue(req.query?.buscar) ? String(req.query.buscar).replace(/\s+/g, ' ').trim().slice(0, 120) : null;
    const result = await dependencies.db.query(
      `
        SELECT p.id_proveedor, p.nombre_proveedor,
               COUNT(*) OVER()::integer AS total_count
        FROM public.proveedores p
        WHERE COALESCE(p.estado, true) = true
          AND ($1::text IS NULL OR p.nombre_proveedor ILIKE '%' || $1 || '%')
        ORDER BY LOWER(p.nombre_proveedor), p.id_proveedor
        LIMIT $2 OFFSET $3
      `,
      [search, pagination.limit, pagination.offset]
    );
    const total = Number(result.rows?.[0]?.total_count ?? 0);
    return {
      ok: true,
      proveedores: (result.rows || []).map((row) => ({
        id_proveedor: Number(row.id_proveedor),
        nombre_proveedor: row.nombre_proveedor
      })),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        total_pages: Math.ceil(total / pagination.limit)
      }
    };
  };

  const approve = async (req) => {
    const requestId = parsePositiveIntStrict(req.params?.id_solicitud_compra);
    if (!requestId) fail(400, 'VALIDATION_ERROR', 'id_solicitud_compra debe ser un entero positivo.');
    const payload = validateApprovalPayload(req.body);
    const client = await dependencies.db.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const access = await assertAdministrativeAccess(req, client, dependencies.readAccess);
      const headerResult = await client.query(
        `
          SELECT id_solicitud_compra, id_almacen, estado, inventario_aplicado
          FROM public.solicitudes_compra
          WHERE id_solicitud_compra = $1
          FOR UPDATE
        `,
        [requestId]
      );
      const header = headerResult.rows?.[0];
      assertPendingHeader(header);
      const storedResult = await client.query(
        `
          SELECT id_solicitud_detalle, tipo_item, id_producto, id_insumo,
                 factor_conversion_snapshot
          FROM public.solicitudes_compra_detalle
          WHERE id_solicitud_compra = $1
          ORDER BY id_solicitud_detalle
          FOR UPDATE
        `,
        [requestId]
      );
      const storedDetails = storedResult.rows || [];
      if (storedDetails.length !== payload.details.length) {
        fail(400, 'VALIDATION_ERROR', 'El payload debe contener exactamente todas las lineas actuales de la solicitud.');
      }
      const storedById = new Map(storedDetails.map((detail) => [Number(detail.id_solicitud_detalle), detail]));
      if (payload.details.some((detail) => !storedById.has(detail.id_solicitud_detalle))) {
        fail(400, 'VALIDATION_ERROR', 'El payload contiene una linea que no pertenece a la solicitud.');
      }

      const normalizedDetails = payload.details.map((submitted) => {
        const stored = storedById.get(submitted.id_solicitud_detalle);
        const type = String(stored.tipo_item || '').trim().toUpperCase();
        if (!['PRODUCTO', 'INSUMO'].includes(type)) fail(409, 'CONFLICT', 'La solicitud contiene un tipo de item no valido.');
        const quantity = parseQuantity(submitted.rawQuantity, { integerOnly: type === 'PRODUCTO' });
        if (!quantity) {
          fail(400, 'VALIDATION_ERROR', type === 'PRODUCTO'
            ? 'La cantidad aprobada de un producto debe ser un entero positivo.'
            : 'La cantidad aprobada de un insumo debe ser positiva y tener hasta 4 decimales.');
        }
        const factor = type === 'PRODUCTO' ? '1' : String(stored.factor_conversion_snapshot ?? '').trim();
        return {
          ...submitted,
          type,
          masterId: parsePositiveIntStrict(type === 'PRODUCTO' ? stored.id_producto : stored.id_insumo),
          approvedQuantity: quantity.decimal,
          approvedBaseQuantity: type === 'PRODUCTO'
            ? quantity.decimal
            : multiplyApprovedQuantityToBase(quantity.decimal, factor)
        };
      });

      const providerIds = Array.from(new Set(normalizedDetails.map((detail) => detail.id_proveedor)));
      const providersResult = await client.query(
        `
          SELECT id_proveedor
          FROM public.proveedores
          WHERE id_proveedor = ANY($1::int[])
            AND COALESCE(estado, true) = true
        `,
        [providerIds]
      );
      const activeProviderIds = new Set((providersResult.rows || []).map((row) => Number(row.id_proveedor)));
      if (providerIds.some((providerId) => !activeProviderIds.has(providerId))) {
        fail(400, 'VALIDATION_ERROR', 'Uno o mas proveedores no existen o estan inactivos.');
      }

      for (const detail of normalizedDetails) {
        if (!detail.masterId) fail(409, 'CONFLICT', 'La linea no conserva un item maestro valido.');
        const entityType = detail.type.toLowerCase();
        const resolved = await dependencies.resolveMaster(entityType, detail.masterId, client);
        if (!resolved.ok || !resolved.master?.estado_global) {
          fail(409, 'CONFLICT', `El ${entityType} maestro ya no esta activo o disponible.`);
        }
        const assignment = await dependencies.getAssignment(entityType, Number(resolved.masterId), Number(header.id_almacen), client);
        if (!assignment || !assignment.activo) {
          fail(409, 'CONFLICT', `El ${entityType} ya no tiene una asignacion activa en el almacen de la solicitud.`);
        }
      }

      for (const detail of normalizedDetails) {
        const updateResult = await client.query(
          `
            UPDATE public.solicitudes_compra_detalle
            SET cantidad_aprobada = $3::numeric,
                cantidad_base_aprobada = $4::numeric,
                id_proveedor = $5
            WHERE id_solicitud_detalle = $1
              AND id_solicitud_compra = $2
          `,
          [
            detail.id_solicitud_detalle,
            requestId,
            detail.approvedQuantity,
            detail.approvedBaseQuantity,
            detail.id_proveedor
          ]
        );
        if (updateResult.rowCount !== 1) fail(409, 'CONFLICT', 'Una linea cambio durante la revision.');
      }

      const approvalResult = await client.query(
        `
          UPDATE public.solicitudes_compra
          SET estado = 'APROBADA',
              comentario_revision = $2,
              id_usuario_revisor = $3,
              fecha_revision = NOW()
          WHERE id_solicitud_compra = $1
            AND estado = 'PENDIENTE'
            AND inventario_aplicado = false
          RETURNING id_solicitud_compra, estado, id_usuario_revisor, fecha_revision
        `,
        [requestId, payload.comment, access.idUsuario]
      );
      if (approvalResult.rowCount !== 1) fail(409, 'INVALID_STATE', 'La solicitud cambio durante la revision.');
      await client.query('COMMIT');
      transactionStarted = false;
      const approved = approvalResult.rows[0];
      return {
        ok: true,
        mensaje: 'Solicitud aprobada correctamente.',
        solicitud: {
          id_solicitud_compra: Number(approved.id_solicitud_compra),
          estado: approved.estado,
          id_usuario_revisor: Number(approved.id_usuario_revisor),
          fecha_revision: approved.fecha_revision,
          total_lineas: normalizedDetails.length
        }
      };
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  };

  const reject = async (req) => {
    const requestId = parsePositiveIntStrict(req.params?.id_solicitud_compra);
    if (!requestId) fail(400, 'VALIDATION_ERROR', 'id_solicitud_compra debe ser un entero positivo.');
    ensurePlainObject(req.body, 'El payload debe ser un objeto.');
    rejectUnexpectedFields(req.body, REJECTION_FIELDS, 'El payload');
    const comment = normalizeComment(req.body.comentario_revision, { required: true });
    const client = await dependencies.db.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const access = await assertAdministrativeAccess(req, client, dependencies.readAccess);
      const headerResult = await client.query(
        `
          SELECT id_solicitud_compra, estado, inventario_aplicado
          FROM public.solicitudes_compra
          WHERE id_solicitud_compra = $1
          FOR UPDATE
        `,
        [requestId]
      );
      assertPendingHeader(headerResult.rows?.[0]);
      const rejectionResult = await client.query(
        `
          UPDATE public.solicitudes_compra
          SET estado = 'RECHAZADA',
              comentario_revision = $2,
              id_usuario_revisor = $3,
              fecha_revision = NOW()
          WHERE id_solicitud_compra = $1
            AND estado = 'PENDIENTE'
            AND inventario_aplicado = false
          RETURNING id_solicitud_compra, estado, comentario_revision,
                    id_usuario_revisor, fecha_revision
        `,
        [requestId, comment, access.idUsuario]
      );
      if (rejectionResult.rowCount !== 1) fail(409, 'INVALID_STATE', 'La solicitud cambio durante la revision.');
      await client.query('COMMIT');
      transactionStarted = false;
      const rejected = rejectionResult.rows[0];
      return {
        ok: true,
        mensaje: 'Solicitud rechazada correctamente.',
        solicitud: {
          id_solicitud_compra: Number(rejected.id_solicitud_compra),
          estado: rejected.estado,
          comentario_revision: rejected.comentario_revision,
          id_usuario_revisor: Number(rejected.id_usuario_revisor),
          fecha_revision: rejected.fecha_revision
        }
      };
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  };

  return { listProviders, approve, reject };
};

export const solicitudesCompraRevisionService = createSolicitudesCompraRevisionService();
