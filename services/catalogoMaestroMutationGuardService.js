import pool from '../config/db-connection.js';
import { resolveCatalogoMaestroEntity } from './catalogoMaestroAsignacionesService.js';

const ENTITY_CONFIG = Object.freeze({
  producto: {
    table: 'productos',
    idColumn: 'id_producto',
    nameColumn: 'nombre_producto',
    mappingTable: 'productos_mapeo_maestro',
    masterIdColumn: 'id_producto_maestro'
  },
  insumo: {
    table: 'insumos',
    idColumn: 'id_insumo',
    nameColumn: 'nombre_insumo',
    mappingTable: 'insumos_mapeo_maestro',
    masterIdColumn: 'id_insumo_maestro'
  }
});

export const CATALOGO_MAESTRO_EXISTENTE_CODE = 'CATALOGO_MAESTRO_EXISTENTE';
export const CATALOGO_LEGACY_READ_ONLY_CODE = 'CATALOGO_LEGACY_READ_ONLY';

const getEntityConfig = (entityType) => {
  const config = ENTITY_CONFIG[entityType];
  if (!config) throw new Error(`Tipo de entidad no soportado: ${entityType}`);
  return config;
};

const normalizeCatalogName = (rawName) =>
  String(rawName ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export const findCatalogoMaestroByNormalizedName = async (entityType, rawName, db = pool) => {
  const config = getEntityConfig(entityType);
  const normalizedName = normalizeCatalogName(rawName);
  if (!normalizedName) return null;

  await db.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`catalogo-maestro:${entityType}:${normalizedName}`]
  );

  const result = await db.query(
    `
      SELECT e.${config.idColumn} AS id_maestro
      FROM public.${config.table} e
      WHERE lower(regexp_replace(btrim(COALESCE(e.${config.nameColumn}, '')), '\\s+', ' ', 'g')) = $1
        AND EXISTS (
          SELECT 1
          FROM public.${config.mappingTable} m
          WHERE m.${config.masterIdColumn} = e.${config.idColumn}
        )
      ORDER BY e.${config.idColumn} ASC
      LIMIT 1
    `,
    [normalizedName]
  );

  const masterId = Number.parseInt(String(result.rows?.[0]?.id_maestro ?? ''), 10);
  return Number.isSafeInteger(masterId) && masterId > 0 ? masterId : null;
};

export const buildCatalogoMaestroExistingResponse = (entityType, masterId) => ({
  error: true,
  code: CATALOGO_MAESTRO_EXISTENTE_CODE,
  id_maestro: masterId,
  message: `Ya existe este ${entityType} maestro. Usa Gestionar sucursales para asignarlo.`
});

export const resolveCatalogoMaestroMutationTarget = async (entityType, rawId, db = pool) => {
  const resolved = await resolveCatalogoMaestroEntity(entityType, rawId, db);
  if (!resolved.ok || resolved.entityId === resolved.masterId) return resolved;

  return {
    ok: false,
    status: 409,
    code: CATALOGO_LEGACY_READ_ONLY_CODE,
    id_maestro: resolved.masterId,
    message: 'Este registro pertenece al modelo anterior. Modifica el maestro correspondiente.'
  };
};

export const buildCatalogoMutationErrorResponse = (result) => ({
  error: true,
  ...(result.code ? { code: result.code } : {}),
  ...(result.id_maestro ? { id_maestro: result.id_maestro } : {}),
  message: result.message
});
