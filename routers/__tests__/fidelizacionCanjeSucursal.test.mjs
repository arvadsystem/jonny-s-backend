import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolveFidelizacionScope, fidelizacionService } from '../fidelizacion.js';

// Bloqueante confirmado: canjeablesCliente y createCanje resolvian la
// sucursal del canje via requireOperationalSucursal, que para un
// SUPER_ADMIN caia en silencio a su userSucursalId (si tenia una asignada)
// en vez de exigir seleccion explicita. Se agrego
// requireExplicitSucursalForSuperAdmin (opt-in, default false: no afecta
// los otros 8 usos de resolveFidelizacionScope en este router) que
// responde FIDELIZACION_SUCURSAL_REQUIRED cuando un superadmin no envia
// id_sucursal.
//
// Estas pruebas ejecutan resolveFidelizacionScope real contra un client
// simulado que reconoce, por fragmento de texto SQL, las mismas consultas
// que utils/sucursalScope.js (resolveRequestUserSucursalScope) ejecuta
// realmente. isRequestUserSuperAdmin lee primero req.__isSuperAdmin (cache
// de request) antes de tocar la DB, asi que un req de prueba puede fijarlo
// directamente sin necesitar mockear JWT/roles.

const normalizeSql = (sqlRaw) => String(sqlRaw).replace(/\s+/g, ' ').trim();

const buildScopeClient = ({ userSucursalId = null, allowedSucursalIds = [], sucursales = {} } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sqlRaw, params = []) => {
      const sql = normalizeSql(sqlRaw);
      calls.push({ sql, params });

      if (sql.includes('FROM public.usuarios u') && sql.includes('LEFT JOIN public.empleados e')) {
        return { rows: userSucursalId ? [{ id_sucursal: userSucursalId }] : [], rowCount: userSucursalId ? 1 : 0 };
      }
      if (sql.includes('FROM public.v_usuarios_sucursales_scope')) {
        return {
          rows: allowedSucursalIds.map((id) => ({ id_sucursal: id, es_principal: false })),
          rowCount: allowedSucursalIds.length
        };
      }
      if (sql.includes('FROM public.sucursales')) {
        const idSucursal = Number(params[0]);
        const sucursal = sucursales[idSucursal];
        return { rows: sucursal ? [sucursal] : [], rowCount: sucursal ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const superAdminReq = () => ({ user: { id_usuario: 1 }, __isSuperAdmin: true });
// __accessContext es el cache de request que usa readRequestAccess
// (middleware/checkPermission.js): si ya esta presente, ni
// isRequestUserSuperAdmin ni requestHasAnyPermission tocan la base de
// datos. hasMultisucursal controla si el permiso
// fidelizacion_ver_multisucursal queda incluido (normalizado en
// mayusculas, igual que normalizePermissionName).
const localUserReq = ({ hasMultisucursal = false } = {}) => ({
  user: { id_usuario: 2 },
  __isSuperAdmin: false,
  __accessContext: {
    idUsuario: 2,
    isSuperAdmin: false,
    roles: new Set(),
    permissions: new Set(hasMultisucursal ? ['FIDELIZACION_VER_MULTISUCURSAL'] : [])
  }
});

describe('resolveFidelizacionScope: requireExplicitSucursalForSuperAdmin (ejecutable, sin mockear el modulo)', () => {
  it('SUPER_ADMIN sin id_sucursal -> FIDELIZACION_SUCURSAL_REQUIRED (400), nunca usa userSucursalId en silencio', async () => {
    const client = buildScopeClient({ userSucursalId: 5 });
    await assert.rejects(
      resolveFidelizacionScope({
        req: superAdminReq(),
        client,
        requireOperationalSucursal: true,
        requireExplicitSucursalForSuperAdmin: true
      }),
      (error) => {
        assert.equal(error.code, 'FIDELIZACION_SUCURSAL_REQUIRED');
        assert.equal(error.httpStatus, 400);
        assert.match(error.publicMessage, /Debe seleccionar la sucursal/);
        return true;
      }
    );
  });

  it('SUPER_ADMIN con id_sucursal valido -> targetSucursalId es exactamente la sucursal enviada, valida existencia/estado', async () => {
    const client = buildScopeClient({
      userSucursalId: 5,
      sucursales: { 2: { id_sucursal: 2, nombre_sucursal: 'El Carmen', estado: true } }
    });
    const scope = await resolveFidelizacionScope({
      req: superAdminReq(),
      client,
      requestedSucursalId: 2,
      requireOperationalSucursal: true,
      requireExplicitSucursalForSuperAdmin: true
    });
    assert.equal(scope.targetSucursalId, 2);
    assert.notEqual(scope.targetSucursalId, 5, 'nunca debe caer a userSucursalId cuando se envio una sucursal explicita distinta');
  });

  it('SUPER_ADMIN con id_sucursal inexistente/inactiva -> FIDELIZACION_SUCURSAL_NOT_FOUND', async () => {
    const client = buildScopeClient({ sucursales: {} });
    await assert.rejects(
      resolveFidelizacionScope({
        req: superAdminReq(),
        client,
        requestedSucursalId: 99,
        requireOperationalSucursal: true,
        requireExplicitSucursalForSuperAdmin: true
      }),
      (error) => {
        assert.equal(error.code, 'FIDELIZACION_SUCURSAL_NOT_FOUND');
        return true;
      }
    );
  });

  it('usuario NO superadmin sin id_sucursal -> usa su propia sucursal operativa (comportamiento existente, sin cambios)', async () => {
    const client = buildScopeClient({ userSucursalId: 3, allowedSucursalIds: [3] });
    const scope = await resolveFidelizacionScope({
      req: localUserReq(),
      client,
      requireOperationalSucursal: true,
      requireExplicitSucursalForSuperAdmin: true
    });
    assert.equal(scope.targetSucursalId, 3);
  });

  it('usuario NO superadmin no puede operar una sucursal fuera de su alcance -> 403 FIDELIZACION_SCOPE_FORBIDDEN', async () => {
    const client = buildScopeClient({
      userSucursalId: 3,
      allowedSucursalIds: [3],
      sucursales: { 9: { id_sucursal: 9, nombre_sucursal: 'Otra', estado: true } }
    });
    await assert.rejects(
      resolveFidelizacionScope({
        req: localUserReq(),
        client,
        requestedSucursalId: 9,
        requireOperationalSucursal: true,
        requireExplicitSucursalForSuperAdmin: true
      }),
      (error) => {
        assert.equal(error.code, 'FIDELIZACION_SCOPE_FORBIDDEN');
        assert.equal(error.httpStatus, 403);
        return true;
      }
    );
  });

  it('usuario NO superadmin CON alcance multisucursal si puede operar una sucursal permitida distinta a la propia (regla previa preservada)', async () => {
    // Regla ya existente antes de esta correccion: un usuario no
    // superadmin con acceso multisucursal (allowedSucursalIds incluye mas
    // de una sucursal) puede operar cualquiera de sus sucursales
    // autorizadas, no solo la propia. requireExplicitSucursalForSuperAdmin
    // no le aplica (solo mira scope.isSuperAdmin), asi que este flujo
    // continua exactamente igual.
    const client = buildScopeClient({
      userSucursalId: 3,
      allowedSucursalIds: [3, 7],
      sucursales: { 7: { id_sucursal: 7, nombre_sucursal: '21 de Agosto', estado: true } }
    });
    const scope = await resolveFidelizacionScope({
      req: localUserReq({ hasMultisucursal: true }),
      client,
      requestedSucursalId: 7,
      requireOperationalSucursal: true,
      requireExplicitSucursalForSuperAdmin: true
    });
    assert.equal(scope.targetSucursalId, 7);
  });

  it('usuario NO superadmin SIN el permiso multisucursal no puede operar otra sucursal aunque este en su allowedSucursalIds (el permiso manda, no solo la lista)', async () => {
    const client = buildScopeClient({
      userSucursalId: 3,
      allowedSucursalIds: [3, 7],
      sucursales: { 7: { id_sucursal: 7, nombre_sucursal: '21 de Agosto', estado: true } }
    });
    await assert.rejects(
      resolveFidelizacionScope({
        req: localUserReq({ hasMultisucursal: false }),
        client,
        requestedSucursalId: 7,
        requireOperationalSucursal: true,
        requireExplicitSucursalForSuperAdmin: true
      }),
      (error) => {
        assert.equal(error.code, 'FIDELIZACION_SCOPE_FORBIDDEN');
        return true;
      }
    );
  });

  it('sin requireExplicitSucursalForSuperAdmin (default false, como en getConfiguracion/listClientes/etc.) SUPER_ADMIN sin sucursal sigue cayendo a userSucursalId: comportamiento de otros endpoints no se toco', async () => {
    const client = buildScopeClient({ userSucursalId: 5 });
    const scope = await resolveFidelizacionScope({ req: superAdminReq(), client });
    assert.equal(scope.targetSucursalId, 5);
  });
});

describe('routers/fidelizacion.js: canjeablesCliente y createCanje exigen sucursal explicita para SUPER_ADMIN', () => {
  const getSource = () => readFile(new URL('../fidelizacion.js', import.meta.url), 'utf8');

  it('canjeablesCliente llama resolveFidelizacionScope con requireExplicitSucursalForSuperAdmin: true', async () => {
    const source = await getSource();
    const start = source.indexOf('async canjeablesCliente(req)');
    const end = source.indexOf('\n  },', start);
    const handler = source.slice(start, end);
    assert.match(handler, /requireExplicitSucursalForSuperAdmin:\s*true/);
    assert.match(handler, /requestedSucursalId,/);
  });

  it('createCanje llama resolveFidelizacionScope con requireExplicitSucursalForSuperAdmin: true y acepta id_sucursal en el body', async () => {
    const source = await getSource();
    const start = source.indexOf('async createCanje(req)');
    const end = source.indexOf('\n  },', start);
    const handler = source.slice(start, end);
    assert.match(handler, /requireExplicitSucursalForSuperAdmin:\s*true/);
    assert.match(handler, /allowedFields = new Set\(\['id_cliente', 'id_sucursal', 'items', 'observacion'\]\)/);
    assert.match(handler, /parseNullablePositiveInt\(req\.body\.id_sucursal\)/);
  });

  it('getConfiguracion, listClientes, panel y demas endpoints multisucursal NO pasan requireExplicitSucursalForSuperAdmin (no se les cambio el comportamiento)', async () => {
    const source = await getSource();
    for (const marker of ['async getConfiguracion(req)', 'async listClientes(req)', 'async panel(req)']) {
      const start = source.indexOf(marker);
      assert.notEqual(start, -1, `no se encontro ${marker}`);
      const end = source.indexOf('\n  },', start);
      const handler = source.slice(start, end);
      assert.doesNotMatch(handler, /requireExplicitSucursalForSuperAdmin/);
    }
  });
});

describe('routers/fidelizacion.js: canjeablesCliente y getConfiguracionProducts usan datos maestros + attachImagenPrincipalUrls', () => {
  const getSource = () => readFile(new URL('../fidelizacion.js', import.meta.url), 'utf8');

  it('el router importa attachImagenPrincipalUrls de utils/uploads.js (no construye URLs de imagen manualmente)', async () => {
    const source = await getSource();
    assert.match(source, /import \{ attachImagenPrincipalUrls \} from '\.\.\/utils\/uploads\.js';/);
    const usages = [...source.matchAll(/attachImagenPrincipalUrls\(/g)];
    assert.ok(usages.length >= 2, 'debe usarse tanto en canjeablesCliente como en getConfiguracionProducts');
  });

  it('canjeablesCliente resuelve el catalogo maestro (productos) por separado del stock local (resolveFidelizacionProductAssignments), no via productos.id_almacen', async () => {
    const source = await getSource();
    const start = source.indexOf('async canjeablesCliente(req)');
    const end = source.indexOf('\n  },', start);
    const handler = source.slice(start, end);
    assert.match(handler, /resolveFidelizacionProductAssignments\(/);
    assert.doesNotMatch(handler, /INNER JOIN public\.almacenes a\s*\n\s*ON a\.id_almacen = p\.id_almacen/);
    assert.match(handler, /p\.id_archivo_imagen_principal/);
  });

  it('getConfiguracionProducts recibe req y lo reenvia a attachImagenPrincipalUrls (necesario para construir la URL absoluta)', async () => {
    const source = await getSource();
    assert.match(source, /const getConfiguracionProducts = async \(client, req, idSucursal, lempirasPorPunto = null\) => \{/);
    assert.match(source, /return attachImagenPrincipalUrls\(pool, req, merged\);/);
    assert.match(source, /await getConfiguracionProducts\(\s*\n\s*pool,\s*\n\s*req,/);
  });

  it('saveConfiguracion (PUT) valida la asignacion via resolveFidelizacionProductAssignments, ya no via productos.id_almacen/almacenes LEFT JOIN', async () => {
    const source = await getSource();
    const start = source.indexOf('async saveConfiguracion(req)');
    const end = source.indexOf('\n  },', start);
    const handler = source.slice(start, end);
    assert.match(handler, /resolveFidelizacionProductAssignments\(/);
    assert.match(handler, /FIDELIZACION_PRODUCTO_SIN_ASIGNACION/);
    assert.match(handler, /FIDELIZACION_PRODUCTO_ASIGNACION_AMBIGUA/);
    assert.doesNotMatch(handler, /LEFT JOIN public\.almacenes a\s*\n\s*ON a\.id_almacen = p\.id_almacen/);
  });
});
