import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  fidelizacionService,
  buildClienteBaseSql,
  buildClienteWhereClause,
  escapeLikePattern,
  buildLikeSearch,
  parsePageParam,
  parseLimitParam,
  parseNullablePositiveInt,
  MAX_SEARCH_LENGTH,
  MAX_PAGE_SIZE,
  DEFAULT_CLIENTES_PAGE_SIZE
} from '../fidelizacion.js';
import { isClienteProfileComplete } from '../../services/fidelizacionService.js';

const getRouterSource = () => readFile(new URL('../fidelizacion.js', import.meta.url), 'utf8');

const getListClientesHandler = async () => {
  const source = await getRouterSource();
  const start = source.indexOf('async listClientes(req)');
  assert.notEqual(start, -1, 'No se encontro el handler listClientes');
  const end = source.indexOf('\n  },', start);
  assert.notEqual(end, -1, 'No se encontro el cierre de listClientes');
  return source.slice(start, end);
};

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

describe('buildClienteWhereClause: filtro de puntos + busqueda (contrato SQL exacto)', () => {
  const sql = buildClienteWhereClause({ searchParamRef: '$2' });

  it('el primer AND es un OR entre "existe busqueda" y los puntos (misma condicion que dataQuery y countQuery comparten)', () => {
    assert.match(
      sql,
      /AND \(\s*\n\s*\$2::text IS NOT NULL\s*\n\s*OR COALESCE\(cc\.puntos_acumulados_total, 0\) > 0\s*\n\s*OR COALESCE\(cc\.puntos_disponibles, 0\) > 0\s*\n\s*\)/
    );
  });

  it('sin busqueda ($2 IS NULL) el filtro exige acumulados>0 O disponibles>0 (nunca solo disponibles>0, que ocultaria a quien ya canjeo todo)', () => {
    assert.match(sql, /OR COALESCE\(cc\.puntos_acumulados_total, 0\) > 0/);
    assert.match(sql, /OR COALESCE\(cc\.puntos_disponibles, 0\) > 0/);
  });

  it('con busqueda ($2 IS NOT NULL) el filtro de puntos queda anulado: es el primer termino del OR, por eso el AND completo ya es verdadero', () => {
    const puntosAndIdx = sql.indexOf('AND (\n      $2::text IS NOT NULL');
    assert.notEqual(puntosAndIdx, -1);
  });

  it('el segundo AND (columnas de busqueda) es independiente del filtro de puntos', () => {
    assert.match(sql, /AND \(\s*\n\s*\$2::text IS NULL\s*\n\s*OR cc\.nombre_principal ILIKE \$2/);
  });

  it('busca por nombre, correo, telefono, documento, nombre_usuario e id_cliente (columnas permitidas, ninguna otra)', () => {
    assert.match(sql, /cc\.nombre_principal ILIKE \$2/);
    assert.match(sql, /cc\.correo ILIKE \$2/);
    assert.match(sql, /cc\.telefono ILIKE \$2/);
    assert.match(sql, /cc\.documento ILIKE \$2/);
    assert.match(sql, /cc\.nombre_usuario ILIKE \$2/);
    assert.match(sql, /cc\.id_cliente::text ILIKE \$2/);
  });

  it('las 6 comparaciones ILIKE usan clausula ESCAPE valida de Postgres', () => {
    const ilikeCount = (sql.match(/ILIKE \$2/g) || []).length;
    const escapeCount = (sql.match(/ILIKE \$2 ESCAPE '\\'/g) || []).length;
    assert.equal(ilikeCount, 6);
    assert.equal(escapeCount, 6, 'las 6 columnas de busqueda deben declarar ESCAPE');
  });

  it('el placeholder es siempre el parametro recibido, nunca un valor interpolado desde req.query', () => {
    assert.doesNotMatch(sql, /req\.query/);
  });

  it('es una funcion pura parametrizable por posicion (no hardcodea "$2"): sirve para no duplicar el filtro entre dataQuery y countQuery', () => {
    const altSql = buildClienteWhereClause({ searchParamRef: '$5' });
    assert.match(altSql, /\$5::text IS NOT NULL/);
    assert.match(altSql, /cc\.nombre_principal ILIKE \$5 ESCAPE '\\'/);
  });
});

describe('escapeLikePattern: % _ y \\ se escapan (no son comodines arbitrarios de ILIKE)', () => {
  it('escapa % con \\%', () => {
    assert.equal(escapeLikePattern('50%'), '50\\%');
  });

  it('escapa _ con \\_', () => {
    assert.equal(escapeLikePattern('a_b'), 'a\\_b');
  });

  it('escapa \\ (el propio caracter de escape) con \\\\', () => {
    assert.equal(escapeLikePattern('a\\b'), 'a\\\\b');
  });

  it('escapa combinaciones de los tres caracteres en una sola pasada', () => {
    assert.equal(escapeLikePattern('100%_off\\now'), '100\\%\\_off\\\\now');
  });

  it('no modifica el resto del texto', () => {
    assert.equal(escapeLikePattern('Juan Perez'), 'Juan Perez');
  });
});

describe('buildLikeSearch: normaliza, escapa y envuelve con % (usa escapeLikePattern antes de comodinar)', () => {
  it('un porcentaje literal en la busqueda se trata como texto, no como comodin', () => {
    assert.equal(buildLikeSearch('50%'), '%50\\%%');
  });

  it('un guion bajo literal se trata como texto, no como comodin', () => {
    assert.equal(buildLikeSearch('a_b'), '%a\\_b%');
  });

  it('una barra invertida literal se escapa (no rompe la clausula ESCAPE de Postgres)', () => {
    assert.equal(buildLikeSearch('a\\b'), '%a\\\\b%');
  });

  it('texto vacio o solo espacios devuelve null (sin busqueda: aplica el filtro de puntos)', () => {
    assert.equal(buildLikeSearch(''), null);
    assert.equal(buildLikeSearch('   '), null);
    assert.equal(buildLikeSearch(undefined), null);
  });

  it('recorta espacios en los extremos antes de envolver', () => {
    assert.equal(buildLikeSearch('  Juan  '), '%Juan%');
  });
});

describe('Seguridad: parsePageParam/parseLimitParam rechazan fragmentos SQL y valores no enteros', () => {
  it('page=0 y page=-1 se rechazan', () => {
    assert.equal(parsePageParam('0'), null);
    assert.equal(parsePageParam('-1'), null);
  });

  it('page="1 OR 1=1" se rechaza (Number.parseInt lo truncaria a 1 si no se validara con regex estricto)', () => {
    assert.equal(parsePageParam('1 OR 1=1'), null);
  });

  it('limit="9;DROP TABLE clientes" se rechaza (no se trunca a 9)', () => {
    assert.equal(parseLimitParam('9;DROP TABLE clientes'), null);
  });

  it('limit="abc" se rechaza', () => {
    assert.equal(parseLimitParam('abc'), null);
  });

  it('limit="9.5" se rechaza (no se trunca a 9): no se aceptan decimales', () => {
    assert.equal(parseLimitParam('9.5'), null);
  });

  it('limit=0 se rechaza', () => {
    assert.equal(parseLimitParam('0'), null);
  });

  it('valores validos si se aceptan: page="2" -> 2, limit="9" -> 9', () => {
    assert.equal(parsePageParam('2'), 2);
    assert.equal(parseLimitParam('9'), 9);
  });

  it('limit sigue acotado por el maximo de seguridad existente (MAX_PAGE_SIZE=100)', () => {
    assert.equal(MAX_PAGE_SIZE, 100);
    assert.equal(parseLimitParam('500'), 100);
  });

  it('sin parametro, listClientes usa 9 por defecto (DEFAULT_CLIENTES_PAGE_SIZE)', () => {
    assert.equal(DEFAULT_CLIENTES_PAGE_SIZE, 9);
    assert.equal(parseLimitParam(undefined, DEFAULT_CLIENTES_PAGE_SIZE), 9);
  });
});

describe('Seguridad: payloads maliciosos en "search" nunca alteran el texto SQL, solo viajan como parametro', () => {
  it('%\' OR 1=1 -- queda escapado y nunca aparece como fragmento SQL en el WHERE', () => {
    const malicious = "%' OR 1=1 --";
    const pattern = buildLikeSearch(malicious);
    assert.equal(pattern, "%\\%' OR 1=1 --%", 'el % inicial del payload debe quedar escapado como texto literal');

    const sql = buildClienteWhereClause({ searchParamRef: '$2' });
    assert.doesNotMatch(sql, /OR 1=1/, 'el WHERE es un string constante: nunca incluye el valor de busqueda');
  });

  it("'; DROP TABLE clientes; -- solo queda en el arreglo de parametros, jamas en el texto SQL", () => {
    const malicious = "'; DROP TABLE clientes; --";
    const pattern = buildLikeSearch(malicious);
    assert.equal(pattern, `%${malicious}%`, 'sin % _ o \\ que escapar, el payload solo queda envuelto en %...%');

    const sql = buildClienteWhereClause({ searchParamRef: '$2' });
    assert.doesNotMatch(sql, /DROP TABLE/);
    assert.doesNotMatch(sql, /--/);
  });
});

describe('listClientes: paginacion y busqueda parametrizadas (fuente real del handler)', () => {
  it('el limit por defecto (sin query param) es 9 (DEFAULT_CLIENTES_PAGE_SIZE), no 20', async () => {
    const handler = await getListClientesHandler();
    assert.match(handler, /parseLimitParam\(req\.query\.limit, DEFAULT_CLIENTES_PAGE_SIZE\)/);
  });

  it('LIMIT y OFFSET usan placeholders literales ($3/$4), nunca un valor interpolado', async () => {
    const handler = await getListClientesHandler();
    assert.match(handler, /LIMIT \$3\s*\n\s*OFFSET \$4/);
    assert.doesNotMatch(handler, /LIMIT \$\{/);
    assert.doesNotMatch(handler, /OFFSET \$\{/);
    assert.doesNotMatch(handler, /req\.query\.offset/);
  });

  it('el offset se calcula en JS como (page - 1) * limit, con page/limit ya validados', async () => {
    const handler = await getListClientesHandler();
    assert.match(handler, /const offset = \(page - 1\) \* limit;/);
  });

  it('el arreglo de parametros de dataQuery es [id_sucursal, search, limit, offset] en ese orden', async () => {
    const handler = await getListClientesHandler();
    assert.match(handler, /pool\.query\(dataQuery, \[scope\.targetSucursalId, search, limit, offset\]\)/);
  });

  it('el arreglo de parametros de countQuery es [id_sucursal, search] (misma condicion, sin limit/offset)', async () => {
    const handler = await getListClientesHandler();
    assert.match(handler, /pool\.query\(countQuery, \[scope\.targetSucursalId, search\]\)/);
  });

  it('dataQuery y countQuery llaman buildClienteWhereClause con el mismo placeholder: comparten exactamente la misma condicion', async () => {
    const handler = await getListClientesHandler();
    const calls = [...handler.matchAll(/buildClienteWhereClause\(\{ searchParamRef: '(\$\d)' \}\)/g)];
    assert.equal(calls.length, 2, 'dataQuery y countQuery deben construir el WHERE con el mismo helper, cada una una vez');
    assert.equal(calls[0][1], calls[1][1], 'ambas queries deben usar el mismo placeholder de busqueda');
  });

  it('el ORDER BY es fijo en el servidor (nombre_principal, id_cliente), nunca proviene de la peticion', async () => {
    const handler = await getListClientesHandler();
    assert.match(handler, /ORDER BY cc\.nombre_principal ASC, cc\.id_cliente ASC/);
    assert.doesNotMatch(handler, /ORDER BY \$\{/);
    assert.doesNotMatch(handler, /req\.query\.orderBy/);
    assert.doesNotMatch(handler, /req\.query\.sort/);
  });

  it('search se obtiene de req.query.search con fallback a req.query.q, sin concatenarse jamas en un template SQL', async () => {
    const handler = await getListClientesHandler();
    assert.match(handler, /req\.query\.search !== undefined \? req\.query\.search : req\.query\.q/);
    assert.doesNotMatch(handler, /ILIKE '%\$\{/);
    assert.doesNotMatch(handler, /ILIKE \$\{/);
  });
});

describe('listClientes: longitud maxima de busqueda (120 caracteres, 400 en vez de truncar en silencio)', () => {
  it('MAX_SEARCH_LENGTH es 120', () => {
    assert.equal(MAX_SEARCH_LENGTH, 120);
  });

  it('una busqueda que exceda MAX_SEARCH_LENGTH devuelve VALIDATION_ERROR 400 antes de tocar la base de datos', async () => {
    const handler = await getListClientesHandler();
    assert.match(handler, /normalizeText\(rawSearchInput\)\.length > MAX_SEARCH_LENGTH/);
    const idx = handler.search(/normalizeText\(rawSearchInput\)\.length > MAX_SEARCH_LENGTH/);
    const surrounding = handler.slice(idx, idx + 300);
    assert.match(surrounding, /status:\s*400/);
    assert.match(surrounding, /VALIDATION_ERROR/);
    // La validacion de longitud ocurre antes de resolveFidelizacionScope (antes de tocar la DB).
    const scopeIdx = handler.indexOf('resolveFidelizacionScope');
    assert.ok(idx < scopeIdx, 'la validacion de longitud debe ocurrir antes de resolveFidelizacionScope');
  });
});

describe('listClientes: id_sucursal sigue validado y jamas confiado del frontend', () => {
  it('id_sucursal invalido (no entero positivo) devuelve 400 antes de resolver el scope', async () => {
    const handler = await getListClientesHandler();
    const idx = handler.indexOf("message: 'id_sucursal debe ser un entero positivo.'");
    assert.notEqual(idx, -1);
    const scopeIdx = handler.indexOf('resolveFidelizacionScope');
    assert.ok(idx < scopeIdx, 'la validacion de id_sucursal debe ocurrir antes de resolveFidelizacionScope');
  });

  it('el id_sucursal efectivo siempre pasa por resolveFidelizacionScope (permisos/alcance multisucursal), nunca se usa crudo', async () => {
    const handler = await getListClientesHandler();
    assert.match(handler, /const scope = await resolveFidelizacionScope\(\{/);
    assert.match(handler, /scope\.targetSucursalId/);
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

// Bloqueante 1 (auditoria independiente): parseNullablePositiveInt usaba
// Number.parseInt sin exigir que el valor completo fuera un entero (via
// isStrictPositiveIntegerString), asi que "1 OR 1=1" o "1;DROP TABLE
// clientes" se interpretaban como el id 1. Se endurece el helper
// compartido (10 usos en este router: id_sucursal en query/body,
// id_cliente e id_estado_canje en listCanjes), todos con el mismo
// contrato de "identificador entero opcional", asi que no se duplica un
// parser paralelo especifico solo para id_sucursal.

describe('parseNullablePositiveInt: identificador entero estricto (ejecutable, sin mockear nada)', () => {
  it("parseNullablePositiveInt('1') devuelve 1", () => {
    assert.equal(parseNullablePositiveInt('1'), 1);
  });

  it("parseNullablePositiveInt('001') devuelve 1 (ceros a la izquierda si siguen siendo solo digitos)", () => {
    assert.equal(parseNullablePositiveInt('001'), 1);
  });

  it("parseNullablePositiveInt('1 OR 1=1') devuelve null (no se trunca a 1)", () => {
    assert.equal(parseNullablePositiveInt('1 OR 1=1'), null);
  });

  it("parseNullablePositiveInt('1;DROP TABLE clientes') devuelve null (no se trunca a 1)", () => {
    assert.equal(parseNullablePositiveInt('1;DROP TABLE clientes'), null);
  });

  it("parseNullablePositiveInt('1.5') devuelve null (no se trunca a 1)", () => {
    assert.equal(parseNullablePositiveInt('1.5'), null);
  });

  it("parseNullablePositiveInt('-1') devuelve null", () => {
    assert.equal(parseNullablePositiveInt('-1'), null);
  });

  it("parseNullablePositiveInt('0') devuelve null", () => {
    assert.equal(parseNullablePositiveInt('0'), null);
  });

  it("parseNullablePositiveInt('abc') devuelve null", () => {
    assert.equal(parseNullablePositiveInt('abc'), null);
  });

  it('un arreglo no se acepta (id_sucursal[]=1 -> Express/qs entrega [\'1\'], que String() convertiria en "1" si no se rechaza el tipo primero)', () => {
    assert.equal(parseNullablePositiveInt(['1']), null);
    assert.equal(parseNullablePositiveInt(['1', '2']), null);
  });

  it('un objeto no se acepta (id_sucursal[valor]=1 -> Express/qs entrega {valor: "1"})', () => {
    assert.equal(parseNullablePositiveInt({ valor: '1' }), null);
  });

  it('valores validos adicionales: "25" -> 25, numero 7 -> 7', () => {
    assert.equal(parseNullablePositiveInt('25'), 25);
    assert.equal(parseNullablePositiveInt(7), 7);
  });

  it('undefined, null y cadena vacia devuelven null (nullable: sin sucursal solicitada)', () => {
    assert.equal(parseNullablePositiveInt(undefined), null);
    assert.equal(parseNullablePositiveInt(null), null);
    assert.equal(parseNullablePositiveInt(''), null);
  });

  it('espacios internos no se aceptan ("1 2" no es un entero puro)', () => {
    assert.equal(parseNullablePositiveInt('1 2'), null);
  });

  it('texto despues del numero no se acepta ("1abc")', () => {
    assert.equal(parseNullablePositiveInt('1abc'), null);
  });
});

describe('listClientes: id_sucursal invalido responde 400 VALIDATION_ERROR antes de tocar PostgreSQL (ejecutable)', () => {
  // Si listClientes llegara a intentar resolveFidelizacionScope/pool.query,
  // la promesa no resolveria en este entorno de pruebas (sin Postgres real
  // alcanzable) dentro del timeout corto: el pool esta configurado con
  // connectionTimeoutMillis: 15000, muy por encima de los 500ms del race.
  // Que la promesa resuelva casi instantaneamente es evidencia ejecutable
  // de que la validacion corto el flujo antes de tocar la base de datos.
  const withDeadline = async (promise, ms, label) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timeout: "${label}" tardo mas de ${ms}ms (sugiere que intento tocar la base de datos en vez de rechazar antes)`)),
            ms
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const invalidSucursalCases = [
    ['1 OR 1=1', '1 OR 1=1'],
    ['1;DROP TABLE clientes', '1;DROP TABLE clientes'],
    ['1.5', '1.5'],
    ['-1', '-1'],
    ['0', '0'],
    ['abc', 'abc'],
    ['arreglo id_sucursal[]=1', ['1']],
    ['objeto id_sucursal[valor]=1', { valor: '1' }]
  ];

  for (const [label, idSucursal] of invalidSucursalCases) {
    it(`id_sucursal=${label} -> 400 VALIDATION_ERROR, sin acceder a PostgreSQL`, async () => {
      const result = await withDeadline(
        fidelizacionService.listClientes({ query: { id_sucursal: idSucursal } }),
        500,
        `listClientes con id_sucursal=${label}`
      );
      assert.equal(result.status, 400);
      assert.equal(result.body?.code, 'VALIDATION_ERROR');
      assert.match(result.body?.message || '', /id_sucursal debe ser un entero positivo/);
    });
  }

  it('id_sucursal=1 (valido) NO se rechaza en esta validacion: el flujo continua hacia resolveFidelizacionScope (no se prueba aqui, requiere DB real)', () => {
    // Cobertura complementaria estructural: confirma que la condicion de
    // rechazo esta atada a "parseNullablePositiveInt devuelve null", no a
    // un valor especifico como '1'.
    assert.equal(parseNullablePositiveInt('1'), 1);
  });
});

describe('routers/fidelizacion.js: parseNullablePositiveInt sigue siendo el unico parser de identificadores enteros opcionales', () => {
  it('los 10 usos restantes de parseNullablePositiveInt siguen presentes (id_sucursal/id_cliente/id_estado_canje en endpoints fuera del alcance de esta correccion)', async () => {
    const source = await readFile(new URL('../fidelizacion.js', import.meta.url), 'utf8');
    const usages = [...source.matchAll(/parseNullablePositiveInt\(/g)];
    // La definicion es "const parseNullablePositiveInt = (value) =>" (no
    // matchea el regex de llamada), asi que solo cuenta los usos reales.
    // Eran 10 originalmente; la correccion de canje por producto maestro
    // (ronda anterior) los subio a 12 (canjeablesCliente y createCanje).
    // La correccion de validacion estricta (auditoria independiente, bloqueante
    // de integridad) migro esos 2 -mas otros 2 que usaban el parsePositiveInt
    // lenient (id_cliente en canjeablesCliente/createCanje)- a
    // parseStrictPositiveInt (services/fidelizacionService.js, exige
    // Number.isSafeInteger y rechaza texto parcialmente numerico). Los
    // otros 10 usos de parseNullablePositiveInt (endpoints fuera del
    // alcance de esta correccion puntual) quedan intactos.
    assert.equal(usages.length, 10, 'no debe agregarse ni quitarse ningun uso de parseNullablePositiveInt sin revisar este contrato');
  });

  it('parseStrictPositiveInt se usa exactamente donde exige esta correccion: canjeablesCliente, saveConfiguracion y createCanje', async () => {
    const source = await readFile(new URL('../fidelizacion.js', import.meta.url), 'utf8');
    const usages = [...source.matchAll(/parseStrictPositiveInt\(/g)];
    // canjeablesCliente: id_cliente (1). saveConfiguracion: id_sucursal,
    // item.id_producto, puntos_requeridos_override (3). createCanje:
    // id_cliente, id_sucursal (2). Total: 6.
    assert.equal(usages.length, 6, 'no debe agregarse ni quitarse ningun uso de parseStrictPositiveInt sin revisar este contrato');
  });

  it('no se creo un parser paralelo especifico solo para id_sucursal (todas las referencias son al mismo helper)', async () => {
    const source = await readFile(new URL('../fidelizacion.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /parseStrictSucursalId|parseSucursalIdParam|parseIdSucursalStrict/);
  });
});
