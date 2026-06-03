import pool from '../config/db-connection.js';
import { toPositiveInt } from './pedidoPayloadValidator.js';

const TABLE_MISSING_CODE = '42P01';

const toNullableNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toNullablePositiveInt = (value) => toPositiveInt(value) || null;

const normalizeText = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
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
