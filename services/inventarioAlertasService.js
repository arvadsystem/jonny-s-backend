import pool from '../config/db-connection.js';
import { toPositiveInt } from './pedidoPayloadValidator.js';

const TABLE_MISSING_CODE = '42P01';
const ALLOWED_ALERT_STATES = new Set(['PENDIENTE', 'REVISADA', 'RESUELTA', 'DESCARTADA']);

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const toNullableNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toNullablePositiveInt = (value) => toPositiveInt(value) || null;

const normalizeText = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

const normalizeCode = (value) =>
  String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

const clampInt = (value, { fallback, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const createHttpError = (httpStatus, code, message) => {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.code = code;
  return error;
};

const normalizeColumnArray = (value) => {
  if (Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return [];
  return text
    .slice(1, -1)
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
};

const getAlertasTableCapabilities = async (queryRunner = pool) => {
  try {
    const result = await queryRunner.query(
      `
        SELECT
          to_regclass('public.pedidos_inventario_alertas') IS NOT NULL AS table_exists,
          COALESCE(array_agg(c.column_name) FILTER (WHERE c.column_name IS NOT NULL), '{}'::text[]) AS columns
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'pedidos_inventario_alertas'
          AND c.column_name IN ('resolved_at', 'resolved_by', 'nota_resolucion', 'updated_at')
      `
    );
    const row = result.rows?.[0] || {};
    if (!row.table_exists) return { tableExists: false };

    const columns = new Set(normalizeColumnArray(row.columns));
    return {
      tableExists: true,
      hasResolvedAt: columns.has('resolved_at'),
      hasResolvedBy: columns.has('resolved_by'),
      hasNotaResolucion: columns.has('nota_resolucion'),
      hasUpdatedAt: columns.has('updated_at')
    };
  } catch (error) {
    if (error?.code === TABLE_MISSING_CODE) {
      return { tableExists: false };
    }
    throw error;
  }
};

const resolveAlertType = (motivo) => {
  const code = String(motivo || '').trim().toUpperCase();
  if (code === 'STOCK_INSUFICIENTE') return 'STOCK_INSUFICIENTE_PERMITIDO';
  if (code === 'ALMACEN_DE_OTRA_SUCURSAL') return 'ALMACEN_NO_DESCONTADO';
  if (code.includes('SIN_COMPONENTES')) return 'CONFIGURACION_INCOMPLETA';
  if (code.startsWith('EXTRA_')) return 'CONFIGURACION_EXTRA_INCOMPLETA';
  return 'ADVERTENCIA_INVENTARIO_COCINA';
};

const normalizeWarning = (warning) => {
  if (!warning || typeof warning !== 'object') return null;

  const motivo = normalizeText(warning.motivo);
  if (!motivo) return null;

  const tipoRecurso = normalizeText(warning.tipo_recurso);
  const idRecurso = toNullablePositiveInt(warning.id_recurso);

  return {
    id_detalle_pedido: toNullablePositiveInt(warning.id_detalle_pedido),
    tipo_alerta: resolveAlertType(motivo),
    motivo,
    mensaje: normalizeText(warning.mensaje),
    tipo_recurso: tipoRecurso,
    id_recurso: idRecurso,
    id_producto: toNullablePositiveInt(warning.id_producto),
    id_insumo: toNullablePositiveInt(warning.id_insumo),
    id_receta: toNullablePositiveInt(warning.id_receta),
    id_combo: toNullablePositiveInt(warning.id_combo),
    id_extra: toNullablePositiveInt(warning.id_extra),
    stock_disponible: toNullableNumber(warning.disponible),
    cantidad_requerida: toNullableNumber(warning.requerido),
    deficit: toNullableNumber(warning.faltante),
    payload: warning
  };
};

export const registrarAlertasInventarioPedido = async ({
  id_pedido: idPedidoRaw,
  id_usuario: idUsuarioRaw,
  warnings
}) => {
  const idPedido = toPositiveInt(idPedidoRaw);
  if (!idPedido) return { ok: false, inserted: 0, skipped: 0, reason: 'ID_PEDIDO_INVALIDO' };

  const rows = (Array.isArray(warnings) ? warnings : [])
    .map(normalizeWarning)
    .filter(Boolean);

  if (!rows.length) return { ok: true, inserted: 0, skipped: 0 };

  const idUsuario = toNullablePositiveInt(idUsuarioRaw);

  try {
    const result = await pool.query(
      `
        WITH incoming AS (
          SELECT
            $1::int AS id_pedido,
            x.id_detalle_pedido,
            x.tipo_alerta,
            x.motivo,
            x.mensaje,
            x.tipo_recurso,
            x.id_recurso,
            x.id_producto,
            x.id_insumo,
            x.id_receta,
            x.id_combo,
            x.id_extra,
            x.stock_disponible,
            x.cantidad_requerida,
            x.deficit,
            x.payload,
            $2::int AS created_by
          FROM jsonb_to_recordset($3::jsonb) AS x(
            id_detalle_pedido int,
            tipo_alerta text,
            motivo text,
            mensaje text,
            tipo_recurso text,
            id_recurso int,
            id_producto int,
            id_insumo int,
            id_receta int,
            id_combo int,
            id_extra int,
            stock_disponible numeric,
            cantidad_requerida numeric,
            deficit numeric,
            payload jsonb
          )
        ),
        inserted AS (
          INSERT INTO public.pedidos_inventario_alertas (
            id_pedido,
            id_detalle_pedido,
            tipo_alerta,
            motivo,
            mensaje,
            tipo_recurso,
            id_recurso,
            id_producto,
            id_insumo,
            id_receta,
            id_combo,
            id_extra,
            stock_disponible,
            cantidad_requerida,
            deficit,
            payload,
            created_by
          )
          SELECT
            i.id_pedido,
            i.id_detalle_pedido,
            i.tipo_alerta,
            i.motivo,
            i.mensaje,
            i.tipo_recurso,
            i.id_recurso,
            i.id_producto,
            i.id_insumo,
            i.id_receta,
            i.id_combo,
            i.id_extra,
            i.stock_disponible,
            i.cantidad_requerida,
            i.deficit,
            i.payload,
            i.created_by
          FROM incoming i
          WHERE NOT EXISTS (
            SELECT 1
            FROM public.pedidos_inventario_alertas a
            WHERE a.id_pedido = i.id_pedido
              AND a.motivo = i.motivo
              AND COALESCE(a.tipo_recurso, '') = COALESCE(i.tipo_recurso, '')
              AND COALESCE(a.id_detalle_pedido, 0) = COALESCE(i.id_detalle_pedido, 0)
              AND COALESCE(a.id_recurso, 0) = COALESCE(i.id_recurso, 0)
              AND COALESCE(a.id_producto, 0) = COALESCE(i.id_producto, 0)
              AND COALESCE(a.id_insumo, 0) = COALESCE(i.id_insumo, 0)
              AND COALESCE(a.id_receta, 0) = COALESCE(i.id_receta, 0)
              AND COALESCE(a.id_combo, 0) = COALESCE(i.id_combo, 0)
              AND COALESCE(a.id_extra, 0) = COALESCE(i.id_extra, 0)
          )
          RETURNING id_alerta
        )
        SELECT COUNT(*)::int AS inserted
        FROM inserted
      `,
      [idPedido, idUsuario, JSON.stringify(rows)]
    );

    const inserted = Number(result.rows?.[0]?.inserted || 0);
    return { ok: true, inserted, skipped: rows.length - inserted };
  } catch (error) {
    if (error?.code === TABLE_MISSING_CODE) {
      console.warn('[inventarioAlertas] tabla pedidos_inventario_alertas no existe; migracion pendiente.');
      return { ok: false, inserted: 0, skipped: rows.length, reason: 'MIGRACION_PENDIENTE' };
    }
    console.error('[inventarioAlertas] no se pudieron registrar alertas:', error?.message || error);
    return { ok: false, inserted: 0, skipped: rows.length, reason: 'ERROR_REGISTRO_ALERTAS' };
  }
};

export const listarAlertasInventarioPedido = async (idPedidoRaw) => {
  const idPedido = toPositiveInt(idPedidoRaw);
  if (!idPedido) {
    const error = new Error('id_pedido invalido.');
    error.httpStatus = 400;
    throw error;
  }

  try {
    const result = await pool.query(
      `
        SELECT
          id_alerta,
          id_pedido,
          id_detalle_pedido,
          tipo_alerta,
          motivo,
          mensaje,
          tipo_recurso,
          id_recurso,
          id_producto,
          id_insumo,
          id_receta,
          id_combo,
          id_extra,
          stock_disponible,
          cantidad_requerida,
          deficit,
          estado,
          created_at,
          created_by,
          payload
        FROM public.pedidos_inventario_alertas
        WHERE id_pedido = $1
        ORDER BY created_at DESC, id_alerta DESC
      `,
      [idPedido]
    );

    return {
      ok: true,
      migration_applied: true,
      alertas: result.rows
    };
  } catch (error) {
    if (error?.code === TABLE_MISSING_CODE) {
      return {
        ok: true,
        migration_applied: false,
        alertas: []
      };
    }
    throw error;
  }
};

export const listarAlertasInventario = async (filters = {}) => {
  const page = clampInt(filters.page, { fallback: DEFAULT_PAGE, min: 1 });
  const limit = clampInt(filters.limit, { fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  const offset = (page - 1) * limit;

  const estado = normalizeCode(filters.estado);
  const motivo = normalizeCode(filters.motivo);
  const idPedido = toNullablePositiveInt(filters.id_pedido ?? filters.idPedido);
  const desde = normalizeText(filters.desde);
  const hasta = normalizeText(filters.hasta);

  if (estado && !ALLOWED_ALERT_STATES.has(estado)) {
    throw createHttpError(400, 'INVENTARIO_ALERTA_ESTADO_INVALIDO', 'Estado de alerta invalido.');
  }

  const params = [];
  const where = [];

  if (estado) {
    params.push(estado);
    where.push(`UPPER(a.estado) = $${params.length}`);
  }
  if (motivo) {
    params.push(motivo);
    where.push(`UPPER(a.motivo) = $${params.length}`);
  }
  if (idPedido) {
    params.push(idPedido);
    where.push(`a.id_pedido = $${params.length}`);
  }
  if (desde) {
    params.push(desde);
    where.push(`a.created_at >= $${params.length}::timestamptz`);
  }
  if (hasta) {
    params.push(hasta);
    where.push(`a.created_at <= $${params.length}::timestamptz`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const capabilities = await getAlertasTableCapabilities();

  if (!capabilities.tableExists) {
    return {
      ok: true,
      migration_applied: false,
      revision_columns_applied: false,
      alertas: [],
      pagination: { page, limit, total: 0, total_pages: 0 }
    };
  }

  const resolvedAtSelect = capabilities.hasResolvedAt ? 'a.resolved_at' : 'NULL::timestamptz AS resolved_at';
  const resolvedBySelect = capabilities.hasResolvedBy ? 'a.resolved_by' : 'NULL::int AS resolved_by';
  const notaSelect = capabilities.hasNotaResolucion ? 'a.nota_resolucion' : 'NULL::text AS nota_resolucion';
  const updatedAtSelect = capabilities.hasUpdatedAt ? 'a.updated_at' : 'NULL::timestamptz AS updated_at';
  const resolvedJoin = capabilities.hasResolvedBy
    ? 'LEFT JOIN public.usuarios u_resolved ON u_resolved.id_usuario = a.resolved_by'
    : '';

  const result = await pool.query(
    `
      WITH filtered AS (
        SELECT a.*
        FROM public.pedidos_inventario_alertas a
        ${whereSql}
      ),
      counted AS (
        SELECT COUNT(*)::int AS total
        FROM filtered
      )
      SELECT
        a.id_alerta,
        a.id_pedido,
        a.id_detalle_pedido,
        a.tipo_alerta,
        a.motivo,
        a.mensaje,
        a.tipo_recurso,
        a.id_recurso,
        a.id_producto,
        a.id_insumo,
        a.id_receta,
        a.id_combo,
        a.id_extra,
        a.stock_disponible,
        a.cantidad_requerida,
        a.deficit,
        a.estado,
        a.created_at,
        a.created_by,
        a.payload,
        ${resolvedAtSelect},
        ${resolvedBySelect},
        ${notaSelect},
        ${updatedAtSelect},
        p.id_sucursal,
        p.total AS pedido_total,
        p.fecha_hora_pedido,
        ep.descripcion AS estado_pedido,
        s.nombre_sucursal,
        u_created.nombre_usuario AS created_by_usuario,
        ${capabilities.hasResolvedBy ? 'u_resolved.nombre_usuario' : 'NULL::text'} AS resolved_by_usuario,
        counted.total AS total_count
      FROM filtered a
      CROSS JOIN counted
      LEFT JOIN public.pedidos p ON p.id_pedido = a.id_pedido
      LEFT JOIN public.estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      LEFT JOIN public.sucursales s ON s.id_sucursal = p.id_sucursal
      LEFT JOIN public.usuarios u_created ON u_created.id_usuario = a.created_by
      ${resolvedJoin}
      ORDER BY a.created_at DESC, a.id_alerta DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `,
    [...params, limit, offset]
  );

  const total = Number(result.rows?.[0]?.total_count || 0);

  return {
    ok: true,
    migration_applied: true,
    revision_columns_applied:
      capabilities.hasResolvedAt &&
      capabilities.hasResolvedBy &&
      capabilities.hasNotaResolucion,
    alertas: result.rows,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit)
    }
  };
};

export const actualizarEstadoAlertaInventario = async ({
  id_alerta: idAlertaRaw,
  estado,
  nota_resolucion: notaResolucionRaw,
  id_usuario: idUsuarioRaw
}) => {
  const idAlerta = toPositiveInt(idAlertaRaw);
  if (!idAlerta) {
    throw createHttpError(400, 'INVENTARIO_ALERTA_ID_INVALIDO', 'ID de alerta invalido.');
  }

  const nextEstado = normalizeCode(estado);
  if (!ALLOWED_ALERT_STATES.has(nextEstado)) {
    throw createHttpError(400, 'INVENTARIO_ALERTA_ESTADO_INVALIDO', 'Estado de alerta invalido.');
  }

  const capabilities = await getAlertasTableCapabilities();
  if (!capabilities.tableExists) {
    throw createHttpError(409, 'INVENTARIO_ALERTAS_MIGRACION_PENDIENTE', 'La tabla de alertas de inventario no existe.');
  }

  const idUsuario = toNullablePositiveInt(idUsuarioRaw);
  const notaResolucion = normalizeText(notaResolucionRaw);
  const shouldResolve = nextEstado !== 'PENDIENTE';
  const setClauses = ['estado = $1'];
  const params = [nextEstado];

  if (capabilities.hasResolvedAt) {
    params.push(shouldResolve ? new Date().toISOString() : null);
    setClauses.push(`resolved_at = $${params.length}::timestamptz`);
  }
  if (capabilities.hasResolvedBy) {
    params.push(shouldResolve ? idUsuario : null);
    setClauses.push(`resolved_by = $${params.length}::int`);
  }
  if (capabilities.hasNotaResolucion) {
    params.push(shouldResolve ? notaResolucion : null);
    setClauses.push(`nota_resolucion = $${params.length}`);
  }
  if (capabilities.hasUpdatedAt) {
    setClauses.push('updated_at = NOW()');
  }

  params.push(idAlerta);
  const result = await pool.query(
    `
      UPDATE public.pedidos_inventario_alertas
      SET ${setClauses.join(', ')}
      WHERE id_alerta = $${params.length}
      RETURNING *
    `,
    params
  );

  const alerta = result.rows?.[0] || null;
  if (!alerta) {
    throw createHttpError(404, 'INVENTARIO_ALERTA_NO_ENCONTRADA', 'Alerta de inventario no encontrada.');
  }

  return {
    ok: true,
    revision_columns_applied:
      capabilities.hasResolvedAt &&
      capabilities.hasResolvedBy &&
      capabilities.hasNotaResolucion,
    alerta
  };
};
