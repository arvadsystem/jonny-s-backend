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

const buildPublicBranchAvailabilitySql = ({
  includeImageColumns = false,
  whereClause = 'WHERE COALESCE(base.estado, true) = true',
  limitClause = ''
} = {}) => `
  WITH clock AS (
    SELECT
      (NOW() AT TIME ZONE 'America/Tegucigalpa')::time AS hora_actual,
      (NOW() AT TIME ZONE 'America/Tegucigalpa')::date AS fecha_actual,
      EXTRACT(ISODOW FROM (NOW() AT TIME ZONE 'America/Tegucigalpa'))::int AS dia_semana_actual
  ),
  branch_base AS (
    SELECT
      s.id_sucursal,
      s.nombre_sucursal,
      COALESCE(vsi.texto_direccion, 'Direccion no disponible') AS direccion,
      COALESCE(s.estado, true) AS estado,
      clock.hora_actual,
      CASE
        WHEN fe.id_fecha_especial IS NOT NULL THEN fe.hora_inicio
        WHEN sh.id_horario IS NOT NULL THEN sh.hora_inicio
        ELSE s.hora_inicio
      END AS hora_inicio_operativa,
      CASE
        WHEN fe.id_fecha_especial IS NOT NULL THEN fe.hora_final
        WHEN sh.id_horario IS NOT NULL THEN sh.hora_final
        ELSE s.hora_final
      END AS hora_final_operativa,
      CASE
        WHEN fe.id_fecha_especial IS NOT NULL THEN true
        WHEN sh.id_horario IS NOT NULL THEN true
        WHEN s.hora_inicio IS NOT NULL AND s.hora_final IS NOT NULL THEN true
        ELSE false
      END AS horario_operativo_configurado,
      CASE
        WHEN fe.id_fecha_especial IS NOT NULL THEN COALESCE(fe.cerrado, true)
        WHEN sh.id_horario IS NOT NULL THEN COALESCE(sh.cerrado, true)
        ELSE false
      END AS cerrado_operativo
      ${includeImageColumns ? `,
      s.id_archivo_imagen,
      a.url_publica AS url_imagen` : ''}
    FROM sucursales s
    CROSS JOIN clock
    LEFT JOIN v_sucursales_info vsi
      ON vsi.id_sucursal = s.id_sucursal
    LEFT JOIN LATERAL (
      SELECT
        f.id_fecha_especial,
        f.cerrado,
        f.hora_inicio,
        f.hora_final
      FROM public.sucursales_fechas_especiales f
      WHERE f.id_sucursal = s.id_sucursal
        AND f.fecha = clock.fecha_actual
        AND COALESCE(f.estado, true) = true
      ORDER BY f.id_fecha_especial DESC
      LIMIT 1
    ) fe ON true
    LEFT JOIN LATERAL (
      SELECT
        h.id_horario,
        h.cerrado,
        h.hora_inicio,
        h.hora_final
      FROM public.sucursales_horarios h
      WHERE h.id_sucursal = s.id_sucursal
        AND h.dia_semana = clock.dia_semana_actual
        AND COALESCE(h.estado, true) = true
      LIMIT 1
    ) sh ON true
    ${includeImageColumns ? `
    LEFT JOIN archivos a
      ON a.id_archivo = s.id_archivo_imagen
     AND COALESCE(a.estado, true) = true` : ''}
  )
  SELECT
    base.id_sucursal,
    base.nombre_sucursal,
    base.direccion,
    base.estado,
    base.hora_inicio_operativa AS hora_inicio,
    base.hora_final_operativa AS hora_final,
    base.horario_operativo_configurado,
    base.cerrado_operativo,
    CASE
      WHEN base.cerrado_operativo = true THEN false
      WHEN base.horario_operativo_configurado = false THEN false
      WHEN base.hora_inicio_operativa IS NULL OR base.hora_final_operativa IS NULL THEN false
      WHEN base.hora_final_operativa > base.hora_inicio_operativa
        THEN base.hora_actual >= base.hora_inicio_operativa
         AND base.hora_actual < base.hora_final_operativa
      ELSE base.hora_actual >= base.hora_inicio_operativa
        OR base.hora_actual < base.hora_final_operativa
    END AS abierto_por_horario
    ${includeImageColumns ? `,
    base.id_archivo_imagen,
    base.url_imagen` : ''}
  FROM branch_base base
  ${whereClause}
  ORDER BY base.id_sucursal ASC
  ${limitClause};
`;

// Lista sucursales activas para entrada publica del flujo.
export const fetchPublicBranchesQuery = async () => {
  const query = buildPublicBranchAvailabilitySql({
    includeImageColumns: true,
    whereClause: 'WHERE COALESCE(base.estado, true) = true'
  });

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

// Obtiene el menu publicado resuelto por la funcion oficial de BD.
export const fetchActiveMenuByBranchQuery = async (idSucursal, db = pool) => {
  const query = `
    SELECT
      r.id_menu_vigente,
      r.id_sucursal,
      r.id_menu,
      r.nombre_menu,
      COALESCE(m.descripcion, '') AS menu_descripcion,
      s.nombre_sucursal,
      r.tipo_publicacion,
      r.es_default,
      r.fecha_inicio,
      r.fecha_fin,
      r.prioridad
    FROM public.fn_resolver_menu_publicado($1) r
    INNER JOIN public.menu m
      ON m.id_menu = r.id_menu
    INNER JOIN public.sucursales s
      ON s.id_sucursal = r.id_sucursal
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
  hasRecipeAssignmentTable,
  hasComboAssignmentTable,
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
  const branchParam = withDetailMenuFilter ? '$3' : '$2';
  const branchProductFilter = withDetailMenuFilter
    ? 'AND (dm.id_producto IS NULL OR pa_branch.id_sucursal = $3)'
    : 'AND (dm.id_producto IS NULL OR pa_branch.id_sucursal = $2)';
  const recipeAssignmentFilter = hasRecipeAssignmentTable
    ? `
      AND (
        ${detalleRecetaExpr} IS NULL
        OR ${branchParam}::int IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.menu_receta_almacenes mra
          INNER JOIN public.almacenes ara
            ON ara.id_almacen = mra.id_almacen
           AND COALESCE(ara.estado, true) = true
          INNER JOIN public.sucursales sra
            ON sra.id_sucursal = ara.id_sucursal
           AND COALESCE(sra.estado, true) = true
          WHERE mra.id_receta = ${detalleRecetaExpr}
            AND COALESCE(mra.estado, true) = true
            AND ara.id_sucursal = ${branchParam}
        )
      )
    `
    : '';
  const comboAssignmentFilter = hasComboAssignmentTable
    ? `
      AND (
        ${detalleComboExpr} IS NULL
        OR ${branchParam}::int IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.menu_combo_almacenes mca
          INNER JOIN public.almacenes aca
            ON aca.id_almacen = mca.id_almacen
           AND COALESCE(aca.estado, true) = true
          INNER JOIN public.sucursales sca
            ON sca.id_sucursal = aca.id_sucursal
           AND COALESCE(sca.estado, true) = true
          WHERE mca.id_combo = ${detalleComboExpr}
            AND COALESCE(mca.estado, true) = true
            AND aca.id_sucursal = ${branchParam}
        )
      )
    `
    : '';

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
      pa_branch.cantidad AS cantidad_actual,
      pa_branch.stock_minimo
    FROM detalle_menu dm
    LEFT JOIN LATERAL (
      SELECT MIN(pm.id_producto_maestro)::int AS id_producto_maestro
      FROM public.productos_mapeo_maestro pm
      WHERE pm.id_producto_legacy = dm.id_producto
         OR pm.id_producto_maestro = dm.id_producto
    ) pmr ON dm.id_producto IS NOT NULL
    LEFT JOIN productos p
      ON p.id_producto = COALESCE(pmr.id_producto_maestro, dm.id_producto)
    LEFT JOIN LATERAL (
      SELECT
        a.id_sucursal,
        COALESCE(pa.cantidad, 0)::numeric AS cantidad,
        COALESCE(pa.stock_minimo, 0)::numeric AS stock_minimo
      FROM public.productos_almacenes pa
      INNER JOIN public.almacenes a
        ON a.id_almacen = pa.id_almacen
       AND COALESCE(a.estado, true) = true
      WHERE pa.id_producto = p.id_producto
        AND COALESCE(pa.estado, true) = true
        AND a.id_sucursal = ${withDetailMenuFilter ? '$3' : '$2'}
      ORDER BY pa.id_almacen ASC
      LIMIT 1
    ) pa_branch ON dm.id_producto IS NOT NULL
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
      ${branchProductFilter}
      ${recipeAssignmentFilter}
      ${comboAssignmentFilter}
      ${detalleVisibleFilter}
      ${withDetailMenuFilter ? 'AND dm.id_detalle_menu = $2' : ''}
    ORDER BY COALESCE(dm.orden, 2147483647), dm.id_detalle_menu
    ${withLimit ? 'LIMIT 1' : ''};
  `;
};

// Lista todos los items publicados en detalle_menu para un menu especifico.
export const fetchCatalogRowsByMenuQuery = async (idMenu, idSucursal, db = pool) => {
  const [
    hasProductImageColumn,
    hasDetalleRecetaColumn,
    hasDetalleComboColumn,
    hasDetallePrecioPublicoColumn,
    hasDetalleVisibleColumn,
    hasRecipeAssignmentTable,
    hasComboAssignmentTable
  ] = await Promise.all([
    hasColumn('productos', 'id_archivo_imagen_principal'),
    hasColumn('detalle_menu', 'id_receta'),
    hasColumn('detalle_menu', 'id_combo'),
    hasColumn('detalle_menu', 'precio_publico'),
    hasColumn('detalle_menu', 'visible'),
    hasTable('menu_receta_almacenes'),
    hasTable('menu_combo_almacenes')
  ]);

  const query = buildCatalogSql({
    hasProductImageColumn,
    hasDetalleRecetaColumn,
    hasDetalleComboColumn,
    hasDetallePrecioPublicoColumn,
    hasDetalleVisibleColumn,
    hasRecipeAssignmentTable,
    hasComboAssignmentTable
  });
  const result = await db.query(query, [idMenu, idSucursal]);
  return result.rows;
};

// Disponibilidad puntual de una sucursal para validar pedidos publicos.
export const fetchPublicBranchAvailabilityByIdQuery = async (idSucursal, db = pool) => {
  const query = buildPublicBranchAvailabilitySql({
    whereClause: 'WHERE base.id_sucursal = $1',
    limitClause: 'LIMIT 1'
  });

  const result = await db.query(query, [idSucursal]);
  return result.rows[0] || null;
};

export const fetchPublicMenuExtrasByRecipeIdsQuery = async (recipeIds = [], idSucursal = null, db = pool) => {
  const ids = [...new Set((Array.isArray(recipeIds) ? recipeIds : [])
    .map((value) => Number.parseInt(String(value ?? ''), 10))
    .filter((value) => Number.isInteger(value) && value > 0))];

  if (ids.length === 0) return [];

  const [hasExtrasTable, hasRecipeLinkTable, hasExtraAssignmentsTable] = await Promise.all([
    hasTable('menu_extras'),
    hasTable('menu_extra_receta'),
    hasTable('menu_extra_almacenes')
  ]);

  if (!hasExtrasTable || !hasRecipeLinkTable) return [];
  const branchId = Number.isInteger(Number(idSucursal)) && Number(idSucursal) > 0 ? Number(idSucursal) : null;
  const assignmentJoin = hasExtraAssignmentsTable && branchId
    ? `
      INNER JOIN menu_extra_almacenes mea
        ON mea.id_extra = me.id_extra
       AND COALESCE(mea.estado, true) = true
      INNER JOIN almacenes a
        ON a.id_almacen = mea.id_almacen
       AND COALESCE(a.estado, true) = true
       AND a.id_sucursal = $2
    `
    : '';
  const params = branchId && hasExtraAssignmentsTable ? [ids, branchId] : [ids];

  const result = await db.query(
    `
      SELECT DISTINCT
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
      ${assignmentJoin}
      WHERE mer.id_receta = ANY($1::int[])
        AND COALESCE(mer.estado, true) = true
      ORDER BY mer.id_receta ASC, orden ASC, me.nombre ASC;
    `,
    params
  );

  return result.rows;
};

// Obtiene un item de detalle_menu validado por menu vigente/sucursal.
export const fetchCatalogItemByIdQuery = async ({ idMenu, idDetalleMenu, idSucursal }, db = pool) => {
  const [
    hasProductImageColumn,
    hasDetalleRecetaColumn,
    hasDetalleComboColumn,
    hasDetallePrecioPublicoColumn,
    hasDetalleVisibleColumn,
    hasRecipeAssignmentTable,
    hasComboAssignmentTable
  ] = await Promise.all([
    hasColumn('productos', 'id_archivo_imagen_principal'),
    hasColumn('detalle_menu', 'id_receta'),
    hasColumn('detalle_menu', 'id_combo'),
    hasColumn('detalle_menu', 'precio_publico'),
    hasColumn('detalle_menu', 'visible'),
    hasTable('menu_receta_almacenes'),
    hasTable('menu_combo_almacenes')
  ]);

  const query = buildCatalogSql({
    hasProductImageColumn,
    hasDetalleRecetaColumn,
    hasDetalleComboColumn,
    hasDetallePrecioPublicoColumn,
    hasDetalleVisibleColumn,
    hasRecipeAssignmentTable,
    hasComboAssignmentTable,
    withDetailMenuFilter: true,
    withLimit: true
  });

  const result = await db.query(query, [idMenu, idDetalleMenu, idSucursal]);
  return result.rows[0] || null;
};

// Calcula disponibilidad por receta en base a detalle_recetas + insumos reales.
export const fetchRecipeAvailabilityQuery = async (recipeIds = [], idSucursal = null, db = pool) => {
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) return [];
  const branchId = Number.isInteger(Number(idSucursal)) && Number(idSucursal) > 0 ? Number(idSucursal) : null;
  const hasRecipeAssignmentTable = await hasTable('menu_receta_almacenes');
  const recipeAssignmentDisponibleExpr = hasRecipeAssignmentTable
    ? `
      EXISTS (
        SELECT 1
        FROM public.menu_receta_almacenes mra
        INNER JOIN public.almacenes ara
          ON ara.id_almacen = mra.id_almacen
         AND COALESCE(ara.estado, true) = true
        INNER JOIN public.sucursales sra
          ON sra.id_sucursal = ara.id_sucursal
         AND COALESCE(sra.estado, true) = true
        WHERE mra.id_receta = r.id_receta
          AND COALESCE(mra.estado, true) = true
          AND ($2::int IS NULL OR ara.id_sucursal = $2)
      )
    `
    : 'true';

  const query = `
    SELECT
      r.id_receta,
      CASE
        WHEN COALESCE(r.estado, true) = false THEN false
        WHEN (${recipeAssignmentDisponibleExpr}) = false THEN false
        WHEN COALESCE(stats.total_componentes, 0) = 0 THEN false
        WHEN COALESCE(stats.componentes_disponibles, 0) = COALESCE(stats.total_componentes, 0) THEN true
        ELSE false
      END AS disponible,
      CASE
        WHEN COALESCE(r.estado, true) = false THEN 'RECETA_INACTIVA'
        WHEN (${recipeAssignmentDisponibleExpr}) = false THEN 'RECETA_SIN_ASIGNACION_SUCURSAL'
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
            AND EXISTS (
              SELECT 1
              FROM public.insumos_almacenes ia
              INNER JOIN public.almacenes a
                ON a.id_almacen = ia.id_almacen
               AND COALESCE(a.estado, true) = true
              WHERE ia.id_insumo = i.id_insumo
                AND COALESCE(ia.estado, true) = true
                AND ($2::int IS NULL OR a.id_sucursal = $2)
                AND (COALESCE(ia.cantidad, 0)::numeric - COALESCE(ia.stock_minimo, 0)::numeric) >= COALESCE(dr.cant, 0)
            )
        ) AS componentes_disponibles
      FROM detalle_recetas dr
      LEFT JOIN LATERAL (
        SELECT MIN(mm.id_insumo_maestro)::int AS id_insumo_maestro
        FROM public.insumos_mapeo_maestro mm
        WHERE mm.id_insumo_legacy = dr.id_insumo
           OR mm.id_insumo_maestro = dr.id_insumo
      ) mmr ON true
      LEFT JOIN insumos i
        ON i.id_insumo = COALESCE(mmr.id_insumo_maestro, dr.id_insumo)
      WHERE dr.id_receta = ANY($1::int[])
      GROUP BY dr.id_receta
    ) stats
      ON stats.id_receta = r.id_receta
    WHERE r.id_receta = ANY($1::int[]);
  `;

  const result = await db.query(query, [recipeIds, branchId]);
  return result.rows;
};

// Calcula disponibilidad por combo en base a sus recetas componentes y stock de insumos.
export const fetchComboAvailabilityQuery = async (comboIds = [], idSucursal = null, db = pool) => {
  if (!Array.isArray(comboIds) || comboIds.length === 0) return [];
  const branchId = Number.isInteger(Number(idSucursal)) && Number(idSucursal) > 0 ? Number(idSucursal) : null;
  const hasComboAssignmentTable = await hasTable('menu_combo_almacenes');
  const comboAssignmentDisponibleExpr = hasComboAssignmentTable
    ? `
      EXISTS (
        SELECT 1
        FROM public.menu_combo_almacenes mca
        INNER JOIN public.almacenes aca
          ON aca.id_almacen = mca.id_almacen
         AND COALESCE(aca.estado, true) = true
        INNER JOIN public.sucursales sca
          ON sca.id_sucursal = aca.id_sucursal
         AND COALESCE(sca.estado, true) = true
        WHERE mca.id_combo = c.id_combo
          AND COALESCE(mca.estado, true) = true
          AND ($2::int IS NULL OR aca.id_sucursal = $2)
      )
    `
    : 'true';

  const query = `
    SELECT
      c.id_combo,
      CASE
        WHEN COALESCE(c.estado, true) = false THEN false
        WHEN (${comboAssignmentDisponibleExpr}) = false THEN false
        WHEN COALESCE(stats.total_componentes, 0) = 0 THEN false
        WHEN COALESCE(stats.componentes_disponibles, 0) = COALESCE(stats.total_componentes, 0) THEN true
        ELSE false
      END AS disponible,
      CASE
        WHEN COALESCE(c.estado, true) = false THEN 'COMBO_INACTIVO'
        WHEN (${comboAssignmentDisponibleExpr}) = false THEN 'COMBO_SIN_ASIGNACION_SUCURSAL'
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
              AND EXISTS (
                SELECT 1
                FROM public.insumos_almacenes ia
                INNER JOIN public.almacenes a
                  ON a.id_almacen = ia.id_almacen
                 AND COALESCE(a.estado, true) = true
                WHERE ia.id_insumo = i.id_insumo
                  AND COALESCE(ia.estado, true) = true
                  AND ($2::int IS NULL OR a.id_sucursal = $2)
                  AND (COALESCE(ia.cantidad, 0)::numeric - COALESCE(ia.stock_minimo, 0)::numeric)
                    >= (COALESCE(dr.cant, 0) * GREATEST(COALESCE(dc.cantidad, 1), 1)::numeric)
              )
          ) AS insumos_disponibles
        FROM detalle_recetas dr
        LEFT JOIN LATERAL (
          SELECT MIN(mm.id_insumo_maestro)::int AS id_insumo_maestro
          FROM public.insumos_mapeo_maestro mm
          WHERE mm.id_insumo_legacy = dr.id_insumo
             OR mm.id_insumo_maestro = dr.id_insumo
        ) mmr ON true
        LEFT JOIN insumos i
          ON i.id_insumo = COALESCE(mmr.id_insumo_maestro, dr.id_insumo)
        WHERE dr.id_receta = dc.id_receta
      ) rs ON true
      WHERE dc.id_combo = ANY($1::int[])
      GROUP BY dc.id_combo
    ) stats
      ON stats.id_combo = c.id_combo
    WHERE c.id_combo = ANY($1::int[]);
  `;

  const result = await db.query(query, [comboIds, branchId]);
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
  const [
    hasEstadoPagoColumn,
    hasTipoEntregaColumn,
    hasValidacionPagoVenceAtColumn,
    hasVisibleEnCocinaAtColumn
  ] = await Promise.all([
    hasColumn('pedidos', 'estado_pago'),
    hasColumn('pedidos', 'tipo_entrega'),
    hasColumn('pedidos', 'validacion_pago_vence_at'),
    hasColumn('pedidos', 'visible_en_cocina_at')
  ]);

  const columns = ['fecha_hora_pedido'];
  const values = ["(NOW() AT TIME ZONE 'America/Tegucigalpa')"];
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

  if (hasVisibleEnCocinaAtColumn) {
    pushExpression('visible_en_cocina_at', 'NULL');
  }

  if (hasValidacionPagoVenceAtColumn) {
    // Usa hora Honduras del motor de BD para alinear el tablero diario de Ventas.
    // Si viene valor explicito, lo respeta; si no, define ventana de 10 minutos en SQL.
    if (payload.validacion_pago_vence_at) {
      pushValue('validacion_pago_vence_at', payload.validacion_pago_vence_at);
    } else {
      pushExpression('validacion_pago_vence_at', "(NOW() AT TIME ZONE 'America/Tegucigalpa') + INTERVAL '10 minutes'");
    }
  }

  const returningColumns = ['id_pedido', 'fecha_hora_pedido'];
  if (hasValidacionPagoVenceAtColumn) {
    returningColumns.push('validacion_pago_vence_at');
  }

  const result = await client.query(
    `
      INSERT INTO pedidos (
        ${columns.join(',\n        ')}
      )
      VALUES (${values.join(', ')})
      RETURNING ${returningColumns.join(', ')};
    `,
    params
  );

  return result.rows[0] || null;
};

export const resolvePublicOrderCatalogContextQuery = async (client, { tipoPedido }) => {
  const [
    hasCanales,
    hasModalidades,
    hasEstadosPago,
    hasMotivosPagoPendiente
  ] = await Promise.all([
    hasTable('cat_pedidos_canales'),
    hasTable('cat_pedidos_modalidades_entrega'),
    hasTable('cat_pedidos_estados_pago'),
    hasTable('cat_pedidos_motivos_pago_pendiente')
  ]);

  const normalizedTipoPedido = String(tipoPedido || '').trim().toLowerCase();
  const canalCode = 'LOCAL';
  const motivoPagoPendienteCandidates = [
    'PENDIENTE_PAGO',
    'PENDIENTE_VALIDACION',
    'VALIDACION_PAGO',
    'PAGO_PENDIENTE',
    'TRANSFERENCIA_PENDIENTE',
    'PENDIENTE'
  ];
  const modalidadCandidates = normalizedTipoPedido === 'delivery'
    ? ['DELIVERY']
    : normalizedTipoPedido === 'pickup'
      ? ['RECOGER', 'PARA_LLEVAR']
      : ['CONSUMO_LOCAL', 'LOCAL'];

  const resolved = {
    id_canal_pedido: null,
    id_modalidad_entrega: null,
    id_estado_pago_pedido: null,
    id_motivo_pago_pendiente: null
  };

  if (hasCanales) {
    const result = await client.query(
      `
        SELECT id_canal_pedido
        FROM public.cat_pedidos_canales
        WHERE UPPER(TRIM(codigo)) = $1
          AND COALESCE(estado, true) = true
        LIMIT 1
      `,
      [canalCode]
    );
    resolved.id_canal_pedido = Number(result.rows?.[0]?.id_canal_pedido || 0) || null;
  }

  if (hasModalidades) {
    const result = await client.query(
      `
        SELECT id_modalidad_entrega
        FROM public.cat_pedidos_modalidades_entrega
        WHERE UPPER(TRIM(codigo)) = ANY($1::text[])
          AND COALESCE(estado, true) = true
        ORDER BY array_position($1::text[], UPPER(TRIM(codigo)))
        LIMIT 1
      `,
      [modalidadCandidates]
    );
    resolved.id_modalidad_entrega = Number(result.rows?.[0]?.id_modalidad_entrega || 0) || null;
  }

  if (hasEstadosPago) {
    const result = await client.query(
      `
        SELECT id_estado_pago_pedido
        FROM public.cat_pedidos_estados_pago
        WHERE UPPER(TRIM(codigo)) = $1
          AND COALESCE(estado, true) = true
        LIMIT 1
      `,
      ['PENDIENTE_VALIDACION']
    );
    resolved.id_estado_pago_pedido = Number(result.rows?.[0]?.id_estado_pago_pedido || 0) || null;
  }

  if (hasMotivosPagoPendiente) {
    const [hasCodigoMotivo, hasNombreMotivo, hasDescripcionMotivo] = await Promise.all([
      hasColumn('cat_pedidos_motivos_pago_pendiente', 'codigo'),
      hasColumn('cat_pedidos_motivos_pago_pendiente', 'nombre'),
      hasColumn('cat_pedidos_motivos_pago_pendiente', 'descripcion')
    ]);
    const predicates = [];
    if (hasCodigoMotivo) predicates.push('UPPER(TRIM(codigo)) = ANY($1::text[])');
    if (hasNombreMotivo) predicates.push('UPPER(TRIM(nombre)) = ANY($1::text[])');
    if (hasDescripcionMotivo) predicates.push('UPPER(TRIM(descripcion)) = ANY($1::text[])');

    if (predicates.length > 0) {
      const result = await client.query(
        `
          SELECT id_motivo_pago_pendiente
          FROM public.cat_pedidos_motivos_pago_pendiente
          WHERE (${predicates.join(' OR ')})
            AND COALESCE(estado, true) = true
          ORDER BY
            ${hasCodigoMotivo ? 'array_position($1::text[], UPPER(TRIM(codigo))) NULLS LAST,' : ''}
            id_motivo_pago_pendiente ASC
          LIMIT 1
        `,
        [motivoPagoPendienteCandidates]
      );
      resolved.id_motivo_pago_pendiente = Number(result.rows?.[0]?.id_motivo_pago_pendiente || 0) || null;
    }
  }

  return resolved;
};

export const insertPublicPedidoContactoQuery = async (client, { idPedido, contacto }) => {
  if (!(await hasTable('pedidos_contacto'))) return false;

  const [
    hasNombreContacto,
    hasTelefonoContacto,
    hasTelefonoNormalizado,
    hasCorreo
  ] = await Promise.all([
    hasColumn('pedidos_contacto', 'nombre_contacto'),
    hasColumn('pedidos_contacto', 'telefono_contacto'),
    hasColumn('pedidos_contacto', 'telefono_normalizado'),
    hasColumn('pedidos_contacto', 'correo')
  ]);
  const columns = ['id_pedido'];
  const params = [idPedido];
  const values = ['$1'];
  const pushValue = (column, value) => {
    params.push(value);
    columns.push(column);
    values.push(`$${params.length}`);
  };

  if (hasNombreContacto) pushValue('nombre_contacto', contacto.nombre);
  if (hasTelefonoContacto) pushValue('telefono_contacto', contacto.telefono);
  if (hasTelefonoNormalizado) pushValue('telefono_normalizado', contacto.telefono_normalizado);
  if (hasCorreo) pushValue('correo', contacto.correo);

  await client.query(
    `
      INSERT INTO public.pedidos_contacto (
        ${columns.join(',\n        ')}
      )
      VALUES (${values.join(', ')})
    `,
    params
  );
  return true;
};

export const insertPublicPedidoContextoQuery = async (client, {
  idPedido,
  idCanalPedido,
  idModalidadEntrega,
  observacionContexto
}) => {
  if (!(await hasTable('pedidos_contexto')) || !idCanalPedido || !idModalidadEntrega) return false;

  const hasObservacionContexto = await hasColumn('pedidos_contexto', 'observacion_contexto');
  const columns = ['id_pedido', 'id_canal_pedido', 'id_modalidad_entrega'];
  const params = [idPedido, idCanalPedido, idModalidadEntrega];
  const values = ['$1', '$2', '$3'];
  if (hasObservacionContexto) {
    params.push(observacionContexto || null);
    columns.push('observacion_contexto');
    values.push(`$${params.length}`);
  }

  await client.query(
    `
      INSERT INTO public.pedidos_contexto (
        ${columns.join(',\n        ')}
      )
      VALUES (${values.join(', ')})
    `,
    params
  );
  return true;
};

export const insertPublicPedidoPagoControlQuery = async (client, {
  idPedido,
  idEstadoPagoPedido,
  idMotivoPagoPendiente,
  total
}) => {
  if (!(await hasTable('pedidos_pago_control')) || !idEstadoPagoPedido) return false;

  const [
    hasMotivoPagoPendiente,
    hasFechaPagoConfirmado
  ] = await Promise.all([
    hasColumn('pedidos_pago_control', 'id_motivo_pago_pendiente'),
    hasColumn('pedidos_pago_control', 'fecha_pago_confirmado')
  ]);

  if (hasMotivoPagoPendiente && !idMotivoPagoPendiente) {
    const error = new Error('Configuracion incompleta: no existe motivo de pago pendiente para pedidos publicos.');
    error.status = 409;
    throw error;
  }

  const columns = [
    'id_pedido',
    'id_estado_pago_pedido',
    'monto_total',
    'monto_pagado',
    'monto_pendiente'
  ];
  const values = ['$1', '$2', '$3', '0', '$3'];
  const params = [idPedido, idEstadoPagoPedido, total];
  if (hasMotivoPagoPendiente) {
    params.push(idMotivoPagoPendiente);
    columns.push('id_motivo_pago_pendiente');
    values.push(`$${params.length}`);
  }
  if (hasFechaPagoConfirmado) {
    columns.push('fecha_pago_confirmado');
    values.push('NULL');
  }

  await client.query(
    `
      INSERT INTO public.pedidos_pago_control (
        ${columns.join(',\n        ')}
      )
      VALUES (${values.join(', ')})
    `,
    params
  );
  return true;
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
    'cantidad',
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
    payload.cantidad,
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
    '$9',
    '$10'
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
