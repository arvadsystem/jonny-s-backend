import { resolveSalsasInventory } from '../../ventas/services/salsasInventoryService.js';

const PUBLICATION_BLOCK_CODES = Object.freeze({
  SALSA_INSUMO_NO_CONFIGURADO: 'SALSA_INVENTARIO_NO_CONFIGURADO',
  SALSA_INSUMO_NO_ENCONTRADO: 'SALSA_INSUMO_INVALIDO',
  SALSA_INSUMO_INACTIVO: 'SALSA_INSUMO_INVALIDO',
  SALSA_INSUMO_MAPEO_REQUIERE_REVISION: 'SALSA_INSUMO_INVALIDO',
  SALSA_INSUMO_MAPEO_AMBIGUO: 'SALSA_INSUMO_INVALIDO',
  SALSA_INSUMO_MAPEO_PENDIENTE: 'SALSA_INSUMO_INVALIDO',
  SALSA_INSUMO_SIN_ASIGNACION_SUCURSAL: 'SALSA_SIN_ASIGNACION_INVENTARIO_SUCURSAL',
  SALSA_INSUMO_ASIGNACION_AMBIGUA: 'SALSA_SIN_ASIGNACION_INVENTARIO_SUCURSAL',
  SALSA_STOCK_INSUFICIENTE: 'SALSA_SIN_STOCK',
  SALSA_CANTIDAD_CONSUMO_INVALIDA: 'SALSA_CONVERSION_INVALIDA',
  SALSA_UNIDAD_NO_CONFIGURADA: 'SALSA_CONVERSION_INVALIDA',
  SALSA_UNIDAD_SIN_CONVERSION: 'SALSA_CONVERSION_INVALIDA',
  SALSA_UNIDAD_CONVERSION_AMBIGUA: 'SALSA_CONVERSION_INVALIDA'
});

const PUBLICATION_BLOCK_MESSAGES = Object.freeze({
  SALSA_INACTIVA: 'Activa la salsa antes de publicarla.',
  SALSA_INVENTARIO_NO_CONFIGURADO: 'Configura el insumo y la cantidad de consumo antes de publicar.',
  SALSA_INSUMO_INVALIDO: 'El insumo configurado no tiene un mapeo maestro validado y utilizable.',
  SALSA_SIN_ASIGNACION_INVENTARIO_SUCURSAL: 'El insumo maestro no tiene una asignacion de inventario unica y activa en esta sucursal.',
  SALSA_SIN_STOCK: 'La sucursal no tiene stock suficiente para una porcion de esta salsa.',
  SALSA_CONVERSION_INVALIDA: 'La unidad de consumo no tiene una conversion valida y unica hacia la unidad base.'
});

const toPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const normalizeSalsaSucursalPublicationPayload = (payload) => {
  if (!Array.isArray(payload?.sucursales)) {
    return { ok: false, message: 'sucursales debe ser un arreglo.' };
  }
  const seen = new Set();
  const sucursales = [];
  for (const row of payload.sucursales) {
    const idSucursal = toPositiveInt(row?.id_sucursal);
    if (!idSucursal || typeof row?.publicada !== 'boolean') {
      return { ok: false, message: 'Cada sucursal requiere id_sucursal valido y publicada booleana.' };
    }
    if (seen.has(idSucursal)) {
      return { ok: false, message: `La sucursal ${idSucursal} esta repetida.` };
    }
    seen.add(idSucursal);
    sucursales.push({ id_sucursal: idSucursal, publicada: row.publicada });
  }
  return { ok: true, sucursales };
};

export const classifySalsaPublicationInventory = ({ salsaActiva, inventory }) => {
  if (!salsaActiva) {
    return {
      puede_publicarse: false,
      codigo_bloqueo: 'SALSA_INACTIVA',
      motivo_bloqueo: PUBLICATION_BLOCK_MESSAGES.SALSA_INACTIVA
    };
  }
  if (inventory?.disponible === true) {
    return { puede_publicarse: true, codigo_bloqueo: null, motivo_bloqueo: null };
  }
  const code = PUBLICATION_BLOCK_CODES[inventory?.codigo_no_disponible] || 'SALSA_INSUMO_INVALIDO';
  return {
    puede_publicarse: false,
    codigo_bloqueo: code,
    motivo_bloqueo: PUBLICATION_BLOCK_MESSAGES[code]
  };
};

export const listSalsaSucursalPublicationState = async (queryRunner, idSalsa) => {
  const salsaId = toPositiveInt(idSalsa);
  if (!queryRunner?.query || !salsaId) return null;
  const salsaResult = await queryRunner.query(
    `
      SELECT
        s.id_salsa,
        s.nombre,
        COALESCE(s.estado, TRUE) AS estado,
        s.id_insumo,
        s.cantidad_porcion,
        s.id_unidad_consumo
      FROM public.salsas s
      WHERE s.id_salsa = $1
      LIMIT 1
    `,
    [salsaId]
  );
  const salsa = salsaResult.rows?.[0];
  if (!salsa) return null;

  const branchesResult = await queryRunner.query(
    `
      SELECT
        su.id_sucursal,
        su.nombre_sucursal,
        COALESCE(ss.publicada, FALSE) AS publicada,
        COALESCE(ss.estado, TRUE) AS estado_publicacion
      FROM public.sucursales su
      LEFT JOIN public.salsa_sucursales ss
        ON ss.id_sucursal = su.id_sucursal
       AND ss.id_salsa = $1
      WHERE COALESCE(su.estado, TRUE) IS TRUE
      ORDER BY su.nombre_sucursal, su.id_sucursal
    `,
    [salsaId]
  );

  const rows = await Promise.all((branchesResult.rows || []).map(async (branch) => {
    const [inventory] = await resolveSalsasInventory({
      queryRunner,
      salsas: [salsa],
      idSucursal: branch.id_sucursal,
      mode: 'catalog'
    });
    const policy = classifySalsaPublicationInventory({
      salsaActiva: salsa.estado === true,
      inventory
    });
    return {
      id_sucursal: Number(branch.id_sucursal),
      nombre_sucursal: branch.nombre_sucursal,
      publicada: branch.estado_publicacion === true && branch.publicada === true,
      estado: branch.estado_publicacion === true,
      inventario_configurado: inventory?.inventario_configurado === true,
      asignacion_inventario: Boolean(inventory?.id_almacen),
      stock_disponible: inventory?.stock_disponible ?? null,
      id_almacen: inventory?.id_almacen ?? null,
      id_insumo_maestro: inventory?.id_insumo_maestro ?? null,
      cantidad_consumo_base: inventory?.cantidad_consumo_base ?? null,
      ...policy
    };
  }));

  return {
    salsa: { id_salsa: Number(salsa.id_salsa), nombre: salsa.nombre, estado: salsa.estado === true },
    sucursales: rows
  };
};

export const saveSalsaSucursalPublicationState = async ({
  client,
  idSalsa,
  idUsuario,
  sucursales
}) => {
  const current = await listSalsaSucursalPublicationState(client, idSalsa);
  if (!current) return { ok: false, status: 404, message: 'Salsa no encontrada.' };
  const byBranch = new Map(current.sucursales.map((row) => [row.id_sucursal, row]));
  for (const requested of sucursales) {
    const branch = byBranch.get(requested.id_sucursal);
    if (!branch) {
      return { ok: false, status: 400, message: `La sucursal ${requested.id_sucursal} no existe o esta inactiva.` };
    }
    if (requested.publicada && !branch.puede_publicarse) {
      return {
        ok: false,
        status: 409,
        code: branch.codigo_bloqueo,
        message: `${branch.nombre_sucursal}: ${branch.motivo_bloqueo}`
      };
    }
  }

  for (const requested of sucursales) {
    await client.query(
      `
        INSERT INTO public.salsa_sucursales (
          id_salsa, id_sucursal, publicada, estado,
          id_usuario_creacion, id_usuario_actualizacion,
          fecha_creacion, fecha_actualizacion
        )
        VALUES ($1, $2, $3, TRUE, $4, $4, NOW(), NOW())
        ON CONFLICT (id_salsa, id_sucursal)
        DO UPDATE SET
          publicada = EXCLUDED.publicada,
          estado = TRUE,
          id_usuario_actualizacion = EXCLUDED.id_usuario_actualizacion,
          fecha_actualizacion = NOW()
      `,
      [idSalsa, requested.id_sucursal, requested.publicada, idUsuario]
    );
  }
  return { ok: true };
};
