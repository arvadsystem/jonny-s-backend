import pool from '../../config/db-connection.js';

// Tipo canonico usado por todo el modulo para no depender de literales sueltas.
export const PUBLIC_ITEM_TYPES = Object.freeze({
  PRODUCTO: 'PRODUCTO',
  RECETA: 'RECETA',
  COMBO: 'COMBO'
});

// Verifica si una columna existe para mantener compatibilidad con esquemas legacy.
const schemaColumnCache = new Map();

const hasColumn = async (tableName, columnName) => {
  const cacheKey = `${String(tableName || '').trim().toLowerCase()}.${String(columnName || '').trim().toLowerCase()}`;
  if (schemaColumnCache.has(cacheKey)) {
    return schemaColumnCache.get(cacheKey);
  }

  const query = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1;
  `;

  const result = await pool.query(query, [tableName, columnName]);
  const exists = result.rowCount > 0;
  schemaColumnCache.set(cacheKey, exists);
  return exists;
};

const hasTable = async (tableName) => {
  const cacheKey = `table.${String(tableName || '').trim().toLowerCase()}`;
  if (schemaColumnCache.has(cacheKey)) {
    return schemaColumnCache.get(cacheKey);
  }

  const result = await pool.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1;
    `,
    [tableName]
  );
  const exists = result.rowCount > 0;
  schemaColumnCache.set(cacheKey, exists);
  return exists;
};

// Lista sucursales activas para entrada publica del flujo.
export const fetchPublicBranchesQuery = async () => {
  const query = `
    WITH clock AS (
      SELECT (NOW() AT TIME ZONE 'America/Tegucigalpa')::time AS hora_actual
    )
    SELECT
      s.id_sucursal,
      s.nombre_sucursal,
      COALESCE(vsi.texto_direccion, 'Direccion no disponible') AS direccion,
      COALESCE(s.estado, true) AS estado,
      s.hora_inicio,
      s.hora_final,
      CASE
        WHEN s.hora_inicio IS NULL OR s.hora_final IS NULL THEN false
        WHEN s.hora_final > s.hora_inicio THEN clock.hora_actual >= s.hora_inicio AND clock.hora_actual < s.hora_final
        ELSE clock.hora_actual >= s.hora_inicio OR clock.hora_actual < s.hora_final
      END AS abierto_por_horario,
      s.id_archivo_imagen,
      a.url_publica AS url_imagen
    FROM sucursales s
    CROSS JOIN clock
    LEFT JOIN v_sucursales_info vsi
      ON vsi.id_sucursal = s.id_sucursal
    LEFT JOIN archivos a
      ON a.id_archivo = s.id_archivo_imagen
     AND COALESCE(a.estado, true) = true
    WHERE COALESCE(s.estado, true) = true
    ORDER BY s.id_sucursal ASC;
  `;

  const result = await pool.query(query);
  return result.rows;
};

// Obtiene horario regular del dia y fecha especial vigente para cada sucursal.
export const fetchBranchOperationalSnapshotQuery = async ({
  branchIds = [],
  diaSemana,
  fechaISO
}) => {
  if (!Array.isArray(branchIds) || branchIds.length === 0) return [];

  const query = `
    SELECT
      s.id_sucursal,
      fe.fecha AS fecha_especial,
      fe.tipo AS tipo_fecha_especial,
      fe.cerrado AS fe_cerrado,
      fe.hora_inicio AS fe_hora_inicio,
      fe.hora_final AS fe_hora_final,
      fe.estado AS fe_estado,
      sh.cerrado AS sh_cerrado,
      sh.hora_inicio AS sh_hora_inicio,
      sh.hora_final AS sh_hora_final,
      sh.estado AS sh_estado
    FROM public.sucursales s
    LEFT JOIN LATERAL (
      SELECT
        f.fecha,
        f.tipo,
        f.cerrado,
        f.hora_inicio,
        f.hora_final,
        f.estado
      FROM public.sucursales_fechas_especiales f
      WHERE f.id_sucursal = s.id_sucursal
        AND f.fecha = $2::date
        AND COALESCE(f.estado, true) = true
      ORDER BY f.id_fecha_especial DESC
      LIMIT 1
    ) fe ON true
    LEFT JOIN LATERAL (
      SELECT
        h.cerrado,
        h.hora_inicio,
        h.hora_final,
        h.estado
      FROM public.sucursales_horarios h
      WHERE h.id_sucursal = s.id_sucursal
        AND h.dia_semana = $3
        AND COALESCE(h.estado, true) = true
      LIMIT 1
    ) sh ON true
    WHERE s.id_sucursal = ANY($1::int[]);
  `;

  const result = await pool.query(query, [branchIds, fechaISO, diaSemana]);
  return result.rows;
};

// Obtiene el menu vigente activo por sucursal (el mas reciente por fecha_inicio).
export const fetchActiveMenuByBranchQuery = async (idSucursal, db = pool) => {
  const query = `
    SELECT
      mv.id_menu_vigente,
      mv.id_sucursal,
      mv.id_menu,
      mv.fecha_inicio,
      m.nombre_menu,
      m.descripcion AS menu_descripcion,
      s.nombre_sucursal
    FROM menu_vigente mv
    INNER JOIN menu m
      ON m.id_menu = mv.id_menu
    INNER JOIN sucursales s
      ON s.id_sucursal = mv.id_sucursal
    WHERE mv.id_sucursal = $1
      AND COALESCE(mv.estado, true) = true
      AND COALESCE(m.estado, true) = true
      AND COALESCE(s.estado, true) = true
      AND COALESCE(mv.fecha_inicio, NOW()) <= NOW()
    ORDER BY mv.fecha_inicio DESC, mv.id_menu_vigente DESC
    LIMIT 1;
  `;

  const result = await db.query(query, [idSucursal]);
  return result.rows[0] || null;
};

// Query base de catalogo: mezcla producto/receta/combo desde detalle_menu (capa de publicacion).
// El SQL se arma dinamico para soportar entornos donde la migracion aun no fue aplicada.
const buildCatalogSql = ({
  hasProductImageColumn,
  hasDetalleRecetaColumn,
  hasDetalleComboColumn,
  hasDetallePrecioPublicoColumn,
  hasDetalleVisibleColumn,
  withDetailMenuFilter = false,
  withLimit = false
}) => {
  const productImageSelect = hasProductImageColumn
    ? 'a_producto.url_publica'
    : 'NULL::character varying';

  const productImageJoin = hasProductImageColumn
    ? `
      LEFT JOIN archivos a_producto
        ON a_producto.id_archivo = p.id_archivo_imagen_principal
       AND COALESCE(a_producto.estado, true) = true
    `
    : '';

  const detalleRecetaExpr = hasDetalleRecetaColumn ? 'dm.id_receta' : 'NULL::integer';
  const detalleComboExpr = hasDetalleComboColumn ? 'dm.id_combo' : 'NULL::integer';
  const detallePrecioPublicoExpr = hasDetallePrecioPublicoColumn
    ? 'dm.precio_publico'
    : 'NULL::numeric(10,2)';
  const detalleVisibleExpr = hasDetalleVisibleColumn ? 'COALESCE(dm.visible, true)' : 'true';
  const detalleVisibleFilter = hasDetalleVisibleColumn ? 'AND COALESCE(dm.visible, true) = true' : '';

  return `
    SELECT
      dm.id_detalle_menu,
      dm.id_menu,
      COALESCE(dm.orden, 0) AS orden,
      ${detallePrecioPublicoExpr} AS precio_publico,
      ${detalleVisibleExpr} AS visible,
      dm.id_producto,
      ${detalleRecetaExpr} AS id_receta,
      ${detalleComboExpr} AS id_combo,
      CASE
        WHEN dm.id_producto IS NOT NULL THEN '${PUBLIC_ITEM_TYPES.PRODUCTO}'
        WHEN ${detalleRecetaExpr} IS NOT NULL THEN '${PUBLIC_ITEM_TYPES.RECETA}'
        WHEN ${detalleComboExpr} IS NOT NULL THEN '${PUBLIC_ITEM_TYPES.COMBO}'
        ELSE NULL
      END AS tipo_item,
      CASE
        WHEN dm.id_producto IS NOT NULL THEN dm.id_producto
        WHEN ${detalleRecetaExpr} IS NOT NULL THEN ${detalleRecetaExpr}
        WHEN ${detalleComboExpr} IS NOT NULL THEN ${detalleComboExpr}
        ELSE NULL
      END AS id_item_base,
      COALESCE(
        p.nombre_producto,
        r.nombre_receta,
        NULLIF(c.nombre_combo, ''),
        NULLIF(c.descripcion, ''),
        CONCAT('Item #', dm.id_detalle_menu::text)
      ) AS nombre_item,
      COALESCE(p.descripcion_producto, r.descripcion, c.descripcion, '') AS descripcion_item,
      CASE
        WHEN dm.id_producto IS NOT NULL THEN p.precio
        WHEN ${detalleRecetaExpr} IS NOT NULL THEN r.precio
        WHEN ${detalleComboExpr} IS NOT NULL THEN c.precio
        ELSE NULL
      END AS precio_base,
      CASE
        WHEN dm.id_producto IS NOT NULL THEN COALESCE(p.estado, true)
        WHEN ${detalleRecetaExpr} IS NOT NULL THEN COALESCE(r.estado, true)
        WHEN ${detalleComboExpr} IS NOT NULL THEN COALESCE(c.estado, true)
        ELSE false
      END AS estado_item_base,
      CASE
        WHEN dm.id_producto IS NOT NULL THEN p.id_tipo_departamento
        WHEN ${detalleRecetaExpr} IS NOT NULL THEN r.id_tipo_departamento
        WHEN ${detalleComboExpr} IS NOT NULL THEN c.id_tipo_departamento
        ELSE NULL
      END AS id_tipo_departamento,
      cp.nombre_categoria AS producto_categoria_nombre,
      CASE
        WHEN dm.id_producto IS NOT NULL
          AND (
            LOWER(TRIM(COALESCE(cp.nombre_categoria, ''))) LIKE '%snack%'
            OR LOWER(TRIM(COALESCE(p.nombre_producto, ''))) LIKE '%snack%'
            OR LOWER(TRIM(COALESCE(p.descripcion_producto, ''))) LIKE '%snack%'
          )
          THEN 'Snacks'
        WHEN dm.id_producto IS NOT NULL
          AND (
            LOWER(TRIM(COALESCE(cp.nombre_categoria, ''))) LIKE '%helado%'
            OR LOWER(TRIM(COALESCE(p.nombre_producto, ''))) LIKE '%helado%'
            OR LOWER(TRIM(COALESCE(p.descripcion_producto, ''))) LIKE '%helado%'
          )
          THEN 'Helados'
        ELSE COALESCE(td.nombre_departamento, cp.nombre_categoria)
      END AS categoria_nombre,
      CASE
        WHEN dm.id_producto IS NOT NULL THEN ${productImageSelect}
        WHEN ${detalleRecetaExpr} IS NOT NULL THEN a_receta.url_publica
        WHEN ${detalleComboExpr} IS NOT NULL THEN a_combo.url_publica
        ELSE NULL
      END AS url_imagen,
      p.cantidad AS cantidad_actual,
      p.stock_minimo
    FROM detalle_menu dm
    LEFT JOIN productos p
      ON p.id_producto = dm.id_producto
    LEFT JOIN categorias_productos cp
      ON cp.id_categoria_producto = p.id_categoria_producto
    ${productImageJoin}
    LEFT JOIN recetas r
      ON r.id_receta = ${detalleRecetaExpr}
    LEFT JOIN archivos a_receta
      ON a_receta.id_archivo = r.id_archivo
     AND COALESCE(a_receta.estado, true) = true
    LEFT JOIN combos c
      ON c.id_combo = ${detalleComboExpr}
    LEFT JOIN archivos a_combo
      ON a_combo.id_archivo = c.id_archivo
     AND COALESCE(a_combo.estado, true) = true
    LEFT JOIN tipo_departamento td
      ON td.id_tipo_departamento = COALESCE(p.id_tipo_departamento, r.id_tipo_departamento, c.id_tipo_departamento)
    WHERE dm.id_menu = $1
      AND COALESCE(dm.estado, true) = true
      ${detalleVisibleFilter}
      ${withDetailMenuFilter ? 'AND dm.id_detalle_menu = $2' : ''}
    ORDER BY COALESCE(dm.orden, 2147483647), dm.id_detalle_menu
    ${withLimit ? 'LIMIT 1' : ''};
  `;
};

// Lista todos los items publicados en detalle_menu para un menu especifico.
export const fetchCatalogRowsByMenuQuery = async (idMenu, db = pool) => {
  const [
    hasProductImageColumn,
    hasDetalleRecetaColumn,
    hasDetalleComboColumn,
    hasDetallePrecioPublicoColumn,
    hasDetalleVisibleColumn
  ] = await Promise.all([
    hasColumn('productos', 'id_archivo_imagen_principal'),
    hasColumn('detalle_menu', 'id_receta'),
    hasColumn('detalle_menu', 'id_combo'),
    hasColumn('detalle_menu', 'precio_publico'),
    hasColumn('detalle_menu', 'visible')
  ]);

  const query = buildCatalogSql({
    hasProductImageColumn,
    hasDetalleRecetaColumn,
    hasDetalleComboColumn,
    hasDetallePrecioPublicoColumn,
    hasDetalleVisibleColumn
  });
  const result = await db.query(query, [idMenu]);
  return result.rows;
};

// Disponibilidad puntual de una sucursal para validar pedidos publicos.
export const fetchPublicBranchAvailabilityByIdQuery = async (idSucursal, db = pool) => {
  const query = `
    WITH clock AS (
      SELECT (NOW() AT TIME ZONE 'America/Tegucigalpa')::time AS hora_actual
    )
    SELECT
      s.id_sucursal,
      s.nombre_sucursal,
      COALESCE(vsi.texto_direccion, 'Direccion no disponible') AS direccion,
      COALESCE(s.estado, true) AS estado,
      s.hora_inicio,
      s.hora_final,
      CASE
        WHEN s.hora_inicio IS NULL OR s.hora_final IS NULL THEN false
        WHEN s.hora_final > s.hora_inicio THEN clock.hora_actual >= s.hora_inicio AND clock.hora_actual < s.hora_final
        ELSE clock.hora_actual >= s.hora_inicio OR clock.hora_actual < s.hora_final
      END AS abierto_por_horario
    FROM sucursales s
    CROSS JOIN clock
    LEFT JOIN v_sucursales_info vsi
      ON vsi.id_sucursal = s.id_sucursal
    WHERE s.id_sucursal = $1
    LIMIT 1;
  `;

  const result = await db.query(query, [idSucursal]);
  return result.rows[0] || null;
};

export const fetchPublicMenuExtrasByRecipeIdsQuery = async (recipeIds = [], db = pool) => {
  const ids = [...new Set((Array.isArray(recipeIds) ? recipeIds : [])
    .map((value) => Number.parseInt(String(value ?? ''), 10))
    .filter((value) => Number.isInteger(value) && value > 0))];

  if (ids.length === 0) return [];

  const [hasExtrasTable, hasRecipeLinkTable] = await Promise.all([
    hasTable('menu_extras'),
    hasTable('menu_extra_receta')
  ]);

  if (!hasExtrasTable || !hasRecipeLinkTable) return [];

  const result = await db.query(
    `
      SELECT
        mer.id_receta,
        me.id_extra,
        me.codigo,
        me.nombre,
        me.precio_adicional,
        COALESCE(mer.orden, me.orden, 0) AS orden
      FROM menu_extra_receta mer
      INNER JOIN menu_extras me
        ON me.id_extra = mer.id_extra
       AND COALESCE(me.estado, true) = true
      WHERE mer.id_receta = ANY($1::int[])
        AND COALESCE(mer.estado, true) = true
      ORDER BY mer.id_receta ASC, COALESCE(mer.orden, me.orden, 2147483647), me.nombre ASC;
    `,
    [ids]
  );

  return result.rows;
};

// Obtiene un item de detalle_menu validado por menu vigente/sucursal.
export const fetchCatalogItemByIdQuery = async ({ idMenu, idDetalleMenu }, db = pool) => {
  const [
    hasProductImageColumn,
    hasDetalleRecetaColumn,
    hasDetalleComboColumn,
    hasDetallePrecioPublicoColumn,
    hasDetalleVisibleColumn
  ] = await Promise.all([
    hasColumn('productos', 'id_archivo_imagen_principal'),
    hasColumn('detalle_menu', 'id_receta'),
    hasColumn('detalle_menu', 'id_combo'),
    hasColumn('detalle_menu', 'precio_publico'),
    hasColumn('detalle_menu', 'visible')
  ]);

  const query = buildCatalogSql({
    hasProductImageColumn,
    hasDetalleRecetaColumn,
    hasDetalleComboColumn,
    hasDetallePrecioPublicoColumn,
    hasDetalleVisibleColumn,
    withDetailMenuFilter: true,
    withLimit: true
  });

  const result = await db.query(query, [idMenu, idDetalleMenu]);
  return result.rows[0] || null;
};

// Calcula disponibilidad por receta en base a detalle_recetas + insumos reales.
export const fetchRecipeAvailabilityQuery = async (recipeIds = [], db = pool) => {
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) return [];

  const query = `
    SELECT
      r.id_receta,
      CASE
        WHEN COALESCE(r.estado, true) = false THEN false
        WHEN COALESCE(stats.total_componentes, 0) = 0 THEN false
        WHEN COALESCE(stats.componentes_disponibles, 0) = COALESCE(stats.total_componentes, 0) THEN true
        ELSE false
      END AS disponible,
      CASE
        WHEN COALESCE(r.estado, true) = false THEN 'RECETA_INACTIVA'
        WHEN COALESCE(stats.total_componentes, 0) = 0 THEN 'RECETA_SIN_DETALLE'
        WHEN COALESCE(stats.componentes_disponibles, 0) < COALESCE(stats.total_componentes, 0) THEN 'INSUMOS_INSUFICIENTES'
        ELSE NULL
      END AS motivo
    FROM recetas r
    LEFT JOIN (
      SELECT
        dr.id_receta,
        COUNT(*) FILTER (WHERE COALESCE(dr.estado, true) = true) AS total_componentes,
        COUNT(*) FILTER (
          WHERE COALESCE(dr.estado, true) = true
            AND i.id_insumo IS NOT NULL
            AND COALESCE(i.estado, true) = true
            AND (COALESCE(i.cantidad, 0)::numeric - COALESCE(i.stock_minimo, 0)::numeric) >= COALESCE(dr.cant, 0)
        ) AS componentes_disponibles
      FROM detalle_recetas dr
      LEFT JOIN insumos i
        ON i.id_insumo = dr.id_insumo
      WHERE dr.id_receta = ANY($1::int[])
      GROUP BY dr.id_receta
    ) stats
      ON stats.id_receta = r.id_receta
    WHERE r.id_receta = ANY($1::int[]);
  `;

  const result = await db.query(query, [recipeIds]);
  return result.rows;
};

// Calcula disponibilidad por combo en base a sus recetas componentes y stock de insumos.
export const fetchComboAvailabilityQuery = async (comboIds = [], db = pool) => {
  if (!Array.isArray(comboIds) || comboIds.length === 0) return [];

  const query = `
    SELECT
      c.id_combo,
      CASE
        WHEN COALESCE(c.estado, true) = false THEN false
        WHEN COALESCE(stats.total_componentes, 0) = 0 THEN false
        WHEN COALESCE(stats.componentes_disponibles, 0) = COALESCE(stats.total_componentes, 0) THEN true
        ELSE false
      END AS disponible,
      CASE
        WHEN COALESCE(c.estado, true) = false THEN 'COMBO_INACTIVO'
        WHEN COALESCE(stats.total_componentes, 0) = 0 THEN 'COMBO_SIN_COMPONENTES'
        WHEN COALESCE(stats.componentes_disponibles, 0) < COALESCE(stats.total_componentes, 0) THEN 'COMPONENTES_NO_DISPONIBLES'
        ELSE NULL
      END AS motivo
    FROM combos c
    LEFT JOIN (
      SELECT
        dc.id_combo,
        COUNT(*) FILTER (WHERE COALESCE(dc.estado, true) = true) AS total_componentes,
        COUNT(*) FILTER (
          WHERE COALESCE(dc.estado, true) = true
            AND r.id_receta IS NOT NULL
            AND COALESCE(r.estado, true) = true
            AND COALESCE(rs.total_insumos, 0) > 0
            AND COALESCE(rs.insumos_disponibles, 0) = COALESCE(rs.total_insumos, 0)
        ) AS componentes_disponibles
      FROM detalle_combo dc
      LEFT JOIN recetas r
        ON r.id_receta = dc.id_receta
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE COALESCE(dr.estado, true) = true) AS total_insumos,
          COUNT(*) FILTER (
            WHERE COALESCE(dr.estado, true) = true
              AND i.id_insumo IS NOT NULL
              AND COALESCE(i.estado, true) = true
              AND (COALESCE(i.cantidad, 0)::numeric - COALESCE(i.stock_minimo, 0)::numeric)
                  >= (COALESCE(dr.cant, 0) * GREATEST(COALESCE(dc.cantidad, 1), 1)::numeric)
          ) AS insumos_disponibles
        FROM detalle_recetas dr
        LEFT JOIN insumos i
          ON i.id_insumo = dr.id_insumo
        WHERE dr.id_receta = dc.id_receta
      ) rs ON true
      WHERE dc.id_combo = ANY($1::int[])
      GROUP BY dc.id_combo
    ) stats
      ON stats.id_combo = c.id_combo
    WHERE c.id_combo = ANY($1::int[]);
  `;

  const result = await db.query(query, [comboIds]);
  return result.rows;
};

// Catalogo de estados de pedido para resolver estado inicial en flujo publico.
export const fetchEstadoPedidoRowsQuery = async (db = pool) => {
  const result = await db.query(
    'SELECT id_estado_pedido, descripcion FROM estados_pedido ORDER BY id_estado_pedido'
  );
  return result.rows;
};

// Componentes receta por combo para calcular reglas de salsas por unidades reales.
export const fetchComboRecipeComponentsQuery = async (comboIds = [], db = pool) => {
  if (!Array.isArray(comboIds) || comboIds.length === 0) return [];

  const result = await db.query(
    `
      SELECT
        dc.id_combo,
        dc.id_receta,
        GREATEST(COALESCE(dc.cantidad, 1), 1)::int AS multiplicador,
        r.nombre_receta
      FROM detalle_combo dc
      INNER JOIN recetas r
        ON r.id_receta = dc.id_receta
      WHERE dc.id_combo = ANY($1::int[])
        AND dc.id_receta IS NOT NULL
        AND COALESCE(dc.estado, true) = true
        AND COALESCE(r.estado, true) = true
      ORDER BY dc.id_combo, COALESCE(dc.orden, dc.id_detalle_combo);
    `,
    [comboIds]
  );

  return result.rows;
};

// Salsas permitidas por receta activa.
export const fetchAllowedSauceRowsByRecipeIdsQuery = async (recipeIds = [], db = pool) => {
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) return [];

  const result = await db.query(
    `
      SELECT
        rs.id_receta,
        s.id_salsa,
        s.nombre,
        s.nivel_picante,
        s.orden,
        COALESCE(s.estado, true) AS disponible
      FROM receta_salsa rs
      INNER JOIN salsas s
        ON s.id_salsa = rs.id_salsa
      WHERE rs.id_receta = ANY($1::int[])
        AND COALESCE(rs.estado, true) = true
      ORDER BY rs.id_receta, s.orden, s.nombre;
    `,
    [recipeIds]
  );

  return result.rows;
};

// Catalogo publico de salsas activas para fallback cuando una receta/combo exige salsas
// pero no tiene mapeo puntual en receta_salsa.
export const fetchPublicActiveSaucesQuery = async (db = pool) => {
  const result = await db.query(
    `
      SELECT
        s.id_salsa,
        s.nombre,
        s.nivel_picante,
        s.orden,
        true AS disponible
      FROM salsas s
      WHERE COALESCE(s.estado, true) = true
      ORDER BY s.orden, s.nombre;
    `
  );

  return result.rows;
};

// Reglas de cuantas salsas son requeridas por rango de unidades.
export const fetchSauceRuleRowsByRecipeIdsQuery = async (recipeIds = [], db = pool) => {
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) return [];

  const result = await db.query(
    `
      SELECT
        id_regla,
        id_receta,
        min_unidades,
        max_unidades,
        salsas_requeridas
      FROM reglas_salsas_receta
      WHERE id_receta = ANY($1::int[])
        AND COALESCE(estado, true) = true
      ORDER BY id_receta, min_unidades, max_unidades NULLS LAST, id_regla;
    `,
    [recipeIds]
  );

  return result.rows;
};

// Usuario fallback para registrar pedidos creados sin login de dashboard.
export const fetchFallbackOrderUserIdQuery = async () => {
  const hasEstadoColumn = await hasColumn('usuarios', 'estado');
  const query = hasEstadoColumn
    ? `
      SELECT id_usuario
      FROM usuarios
      WHERE COALESCE(estado, true) = true
      ORDER BY id_usuario
      LIMIT 1;
    `
    : `
      SELECT id_usuario
      FROM usuarios
      ORDER BY id_usuario
      LIMIT 1;
    `;

  const result = await pool.query(query);
  return result.rows[0]?.id_usuario ? Number(result.rows[0].id_usuario) : null;
};

// Bloquea por llave de idempotencia dentro de la transaccion actual para evitar doble insercion concurrente.
export const acquirePublicOrderIdempotencyLockQuery = async (client, { idCliente, idempotencyKey }) => {
  await client.query(
    `
      SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2));
    `,
    [String(idCliente), String(idempotencyKey)]
  );
};

// Busca un pedido ya creado con la misma llave de idempotencia para devolver respuesta estable en reintentos.
export const fetchPedidoByIdempotencyKeyQuery = async (
  client,
  {
    idCliente,
    idSucursal,
    idempotencyKey
  }
) => {
  const result = await client.query(
    `
      SELECT
        p.id_pedido,
        p.fecha_hora_pedido,
        p.validacion_pago_vence_at,
        p.descripcion_pedido,
        p.total
      FROM pedidos p
      WHERE p.id_cliente = $1
        AND p.id_sucursal = $2
        AND COALESCE(p.origen_pedido, 'MENU') = 'MENU'
        AND p.descripcion_pedido ILIKE $3
      ORDER BY p.id_pedido DESC
      LIMIT 1;
    `,
    [
      Number(idCliente),
      Number(idSucursal),
      `%idem:${String(idempotencyKey)}%`
    ]
  );

  return result.rows[0] || null;
};

// Inserta cabecera de pedido publico y devuelve ID generado.
export const insertPublicPedidoQuery = async (client, payload) => {
  const [hasEstadoPagoColumn, hasTipoEntregaColumn, hasValidacionPagoVenceAtColumn] = await Promise.all([
    hasColumn('pedidos', 'estado_pago'),
    hasColumn('pedidos', 'tipo_entrega'),
    hasColumn('pedidos', 'validacion_pago_vence_at')
  ]);

  const columns = ['fecha_hora_pedido'];
  const values = ['CURRENT_TIMESTAMP'];
  const params = [];
  const pushValue = (column, value) => {
    params.push(value);
    columns.push(column);
    values.push(`$${params.length}`);
  };
  const pushExpression = (column, expression) => {
    columns.push(column);
    values.push(expression);
  };

  // Base minima requerida para pedidos del menu publico.
  pushValue('descripcion_pedido', payload.descripcion_pedido);
  pushValue('descripcion_envio', payload.descripcion_envio);
  pushValue('sub_total', payload.sub_total);
  pushValue('isv', payload.isv);
  pushValue('total', payload.total);
  pushValue('id_estado_pedido', payload.id_estado_pedido);
  pushValue('id_sucursal', payload.id_sucursal);
  pushValue('id_cliente', payload.id_cliente);
  pushValue('id_usuario', payload.id_usuario);
  pushValue('origen_pedido', payload.origen_pedido || 'MENU');

  // Refuerzo item 9: forzamos estado de pago/tipo de entrega si el esquema los soporta.
  if (hasEstadoPagoColumn) {
    pushValue('estado_pago', payload.estado_pago || 'PENDIENTE_VALIDACION');
  }

  if (hasTipoEntregaColumn) {
    pushValue('tipo_entrega', payload.tipo_entrega || 'LOCAL');
  }

  if (hasValidacionPagoVenceAtColumn) {
    // Usa hora del motor de BD para evitar desfases de zona horaria entre app y DB.
    // Si viene valor explicito, lo respeta; si no, define ventana de 10 minutos en SQL.
    if (payload.validacion_pago_vence_at) {
      pushValue('validacion_pago_vence_at', payload.validacion_pago_vence_at);
    } else {
      pushExpression('validacion_pago_vence_at', "NOW() + INTERVAL '10 minutes'");
    }
  }

  const result = await client.query(
    `
      INSERT INTO pedidos (
        ${columns.join(',\n        ')}
      )
      VALUES (${values.join(', ')})
      RETURNING id_pedido, fecha_hora_pedido;
    `,
    params
  );

  return result.rows[0] || null;
};

// Inserta una linea de detalle para pedido publico.
export const insertPublicPedidoDetalleQuery = async (client, payload) => {
  const hasConfiguracionMenuColumn = await hasColumn('detalle_pedido', 'configuracion_menu');

  const columns = [
    'sub_total_pedido',
    'total_pedido',
    'id_producto',
    'id_pedido',
    'id_descuento',
    'estado',
    'id_combo',
    'id_receta',
    'observacion'
  ];
  const params = [
    payload.sub_total_pedido,
    payload.total_pedido,
    payload.id_producto,
    payload.id_pedido,
    null,
    true,
    payload.id_combo,
    payload.id_receta,
    payload.observacion
  ];
  const values = [
    '$1',
    '$2',
    '$3',
    '$4',
    '$5',
    '$6',
    '$7',
    '$8',
    '$9'
  ];

  // Item 11: persistimos configuracion estructurada del menu cuando el esquema lo soporta.
  if (hasConfiguracionMenuColumn) {
    columns.push('configuracion_menu');
    params.push(payload.configuracion_menu ? JSON.stringify(payload.configuracion_menu) : null);
    values.push(`$${params.length}::jsonb`);
  }

  await client.query(
    `
      INSERT INTO detalle_pedido (
        ${columns.join(',\n        ')}
      )
      VALUES (${values.join(', ')});
    `,
    params
  );
};