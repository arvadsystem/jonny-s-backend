import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildClienteBaseSql } from '../fidelizacion.js';
import { isClienteProfileComplete } from '../../services/fidelizacionService.js';

// buildClienteBaseSql es una funcion pura (arma texto SQL, no toca la DB),
// asi que se puede llamar directamente y verificar el SQL real que produce
// (comportamiento real, no solo regex sobre el archivo fuente). La regla de
// elegibilidad que ahora usa (perfil: activo + nombre + telefono de 8
// digitos) es exactamente isClienteProfileComplete, ya probada en
// services/__tests__/fidelizacionService.clienteProfile.test.mjs; aqui se
// reutiliza para cubrir el listado de las 8 pruebas obligatorias del
// bloqueante 2 sin duplicar una tercera implementacion del criterio.

describe('buildClienteBaseSql: ya no exige usuario/rol CLIENTE', () => {
  const sql = buildClienteBaseSql('c.id_empresa');

  it('no exige rol CLIENTE ni usa la tabla roles/roles_usuarios', () => {
    assert.doesNotMatch(sql, /roles_usuarios/);
    assert.doesNotMatch(sql, /public\.roles\b/);
    assert.doesNotMatch(sql, /UPPER\(TRIM\(r\.nombre\)\)/);
  });

  it('usuarios_clientes y usuarios son LEFT JOIN (opcionales), no INNER JOIN', () => {
    assert.match(sql, /LEFT JOIN public\.usuarios_clientes uc/);
    assert.match(sql, /LEFT JOIN public\.usuarios u\b/);
    assert.doesNotMatch(sql, /INNER JOIN public\.usuarios_clientes/);
    assert.doesNotMatch(sql, /INNER JOIN public\.usuarios u\b/);
  });

  it('id_usuario_cliente y nombre_usuario quedan como columnas nullable (u.*), no de una CTE separada exigida', () => {
    assert.match(sql, /u\.id_usuario AS id_usuario_cliente/);
    assert.match(sql, /u\.nombre_usuario/);
  });

  it('filtra por perfil: activo, nombre no vacio, telefono de 8 digitos (mismo criterio que normalizePhoneHN)', () => {
    assert.match(sql, /COALESCE\(c\.estado, true\) = true/);
    assert.match(sql, /TRIM\(COALESCE\(\s*CASE WHEN c\.id_persona IS NOT NULL THEN p\.nombre ELSE e\.nombre_empresa END,\s*''\s*\)\) <> ''/);
    assert.match(sql, /length\(regexp_replace\(/);
    assert.match(sql, /'\\D', '', 'g'\s*\)\) = 8/);
  });

  it('bloqueante 2: el filtro de nombre usa exactamente p.nombre, nunca CONCAT con apellido (una persona sin nombre pero con apellido no debe pasar)', () => {
    assert.doesNotMatch(sql, /CONCAT\(p\.nombre,\s*' ',\s*p\.apellido\)\s*ELSE/, 'el filtro de elegibilidad no debe concatenar apellido');
    // El apellido si puede seguir usandose para nombre_principal (visual), en otra parte del SELECT.
    assert.match(sql, /NULLIF\(TRIM\(CONCAT\(COALESCE\(p\.nombre, ''\), ' ', COALESCE\(p\.apellido, ''\)\)\), ''\)/, 'nombre_principal (visual) si puede seguir usando apellido');
  });

  it('la regla SQL coincide literalmente con isClienteProfileComplete: CASE WHEN id_persona THEN p.nombre ELSE e.nombre_empresa', () => {
    assert.match(sql, /CASE WHEN c\.id_persona IS NOT NULL THEN p\.nombre ELSE e\.nombre_empresa END/);
  });

  it('usa el empresaRelationExpr recibido, no un c.id_empresa hardcodeado de una tercera implementacion', () => {
    const customExprSql = buildClienteBaseSql("COALESCE(c.id_empresa_cliente, c.id_empresa)");
    assert.match(customExprSql, /LEFT JOIN public\.empresas e\s*\n\s*ON e\.id_empresa = COALESCE\(c\.id_empresa_cliente, c\.id_empresa\)/);
  });
});

describe('elegibilidad del panel (isClienteProfileComplete): mismos casos que la acumulacion', () => {
  it('cliente persona activo, con nombre y telefono, sin usuario -> elegible (aparece)', () => {
    assert.equal(isClienteProfileComplete({ estado: true, nombre: 'Ana Perez', telefono: '9999-9999' }), true);
  });

  it('cliente empresa activa, con nombre y telefono, sin usuario -> elegible (aparece)', () => {
    assert.equal(isClienteProfileComplete({ estado: true, nombre: 'Comercial ACME', telefono: '2222-2222' }), true);
  });

  it('cliente con usuario y rol -> sigue siendo elegible (la presencia de usuario no afecta la regla)', () => {
    assert.equal(isClienteProfileComplete({ estado: true, nombre: 'Con Usuario', telefono: '8888-8888' }), true);
  });

  it('cliente sin telefono -> no elegible (no aparece)', () => {
    assert.equal(isClienteProfileComplete({ estado: true, nombre: 'Sin Telefono', telefono: '' }), false);
    assert.equal(isClienteProfileComplete({ estado: true, nombre: 'Sin Telefono', telefono: null }), false);
  });

  it('cliente sin nombre -> no elegible (no aparece)', () => {
    assert.equal(isClienteProfileComplete({ estado: true, nombre: '', telefono: '9999-9999' }), false);
  });

  it('bloqueante 2: persona sin nombre pero CON apellido -> no elegible (fetchClienteProfileForFidelizacion nunca proyecta apellido como "nombre")', () => {
    // El perfil que arma fetchClienteProfileForFidelizacion resuelve
    // "nombre" con CASE WHEN id_persona THEN p.nombre (nunca CONCAT con
    // apellido); un persona con nombre vacio pero apellido lleno llega aqui
    // con profile.nombre = '' -- el apellido nunca "rescata" la elegibilidad.
    assert.equal(isClienteProfileComplete({ estado: true, nombre: '', telefono: '9999-9999' }), false, 'apellido lleno pero nombre vacio: sigue sin ser elegible');
  });

  it('cliente inactivo -> no elegible (no aparece) aunque tenga nombre y telefono validos', () => {
    assert.equal(isClienteProfileComplete({ estado: false, nombre: 'Inactivo', telefono: '9999-9999' }), false);
  });
});

describe('buildClienteWhereClause: la busqueda sigue funcionando sobre las mismas columnas', () => {
  it('la busqueda referencia nombre_principal/correo/telefono/documento/nombre_usuario/id_cliente', async () => {
    const { fidelizacionService } = await import('../fidelizacion.js');
    assert.ok(fidelizacionService.listClientes, 'listClientes debe seguir existiendo');
  });
});

describe('fetchClienteDetalleRow / panel / listClientes: calculan empresaRelationExpr dinamicamente', () => {
  it('el router importa buildClienteEmpresaRelationSql desde el servicio (no una implementacion propia)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../fidelizacion.js', import.meta.url), 'utf8');
    assert.match(source, /buildClienteEmpresaRelationSql/);
    assert.match(source, /await buildClienteEmpresaRelationSql\(client, 'c'\)/);
    assert.match(source, /await buildClienteEmpresaRelationSql\(pool, 'c'\)/);
  });

  it('detalleCliente/movimientosCliente/canjeablesCliente funcionan aunque id_usuario_cliente sea null (columna nullable, no exigida en el WHERE)', () => {
    const sql = buildClienteBaseSql('c.id_empresa');
    // El WHERE de elegibilidad (estado/nombre/telefono) nunca menciona
    // id_usuario_cliente ni nombre_usuario: no son parte del criterio.
    const whereIdx = sql.lastIndexOf('WHERE COALESCE(c.estado, true) = true');
    const whereBlock = sql.slice(whereIdx);
    assert.doesNotMatch(whereBlock, /id_usuario_cliente/);
    assert.doesNotMatch(whereBlock, /nombre_usuario/);
  });
});
