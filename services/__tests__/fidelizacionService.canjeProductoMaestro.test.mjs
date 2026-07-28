import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  resolveFidelizacionProductAssignments,
  createPresentialFidelizacionCanje,
  parseStrictPositiveInt
} from '../fidelizacionService.js';

// Defecto confirmado: Fidelizacion resolvia la sucursal de un producto
// canjeable con productos.id_almacen (un solo almacen "legado" por
// producto), en vez de productos_almacenes (asignacion real por sucursal
// de un producto maestro). Esto rechazaba productos maestros validos
// asignados a mas de una sucursal con "Uno o mas productos no pertenecen
// al inventario operativo de la sucursal."
//
// Estas pruebas ejecutan las funciones reales exportadas por
// fidelizacionService.js (resolveFidelizacionProductAssignments y
// createPresentialFidelizacionCanje) contra un client de PostgreSQL
// simulado (mismo patron ya usado en este repo por
// test/solicitudesCompraRecepcionService.test.js: un query() que reconoce
// cada consulta real por un fragmento de su texto SQL y responde con datos
// controlados). No son solo aserciones sobre el codigo fuente: es la
// logica real corriendo con E/S controlada.

const normalizeSql = (sqlRaw) => String(sqlRaw).replace(/\s+/g, ' ').trim();

const buildAssignmentClient = (responses) => {
  let call = 0;
  const calls = [];
  return {
    calls,
    query: async (sqlRaw, params = []) => {
      const sql = normalizeSql(sqlRaw);
      calls.push({ sql, params });
      const response = responses[call] || { rows: [] };
      call += 1;
      return response;
    }
  };
};

describe('resolveFidelizacionProductAssignments (helper centralizado producto maestro -> asignacion local)', () => {
  it('producto con una unica asignacion activa en la sucursal se resuelve OK, con stock de productos_almacenes', async () => {
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 156, total_asignaciones: 1 }] },
      {
        rows: [{
          id_producto: 156,
          nombre_producto: 'SEVEN UP 1.1 LT',
          descripcion_producto: '',
          precio: 48,
          id_archivo_imagen_principal: 227,
          id_almacen: 1,
          cantidad: 10000,
          stock_minimo: 3,
          id_sucursal: 1,
          nombre_almacen: "Almacen Jonny's el Carmen"
        }]
      }
    ]);

    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [156] });
    const row = result.get(156);

    assert.equal(row.status, 'OK');
    assert.equal(row.nombre_producto, 'SEVEN UP 1.1 LT');
    assert.equal(row.id_almacen, 1);
    assert.equal(row.id_sucursal, 1);
    // Coincide exactamente con el ejemplo de respuesta pedido: cantidad
    // 10000, stock_minimo 3 -> stock_disponible 9997.
    assert.equal(row.cantidad, 10000);
    assert.equal(row.stock_minimo, 3);
    assert.equal(row.stock_disponible, 9997);
  });

  it('producto maestro asignado a dos sucursales: se resuelve con el almacen de la sucursal solicitada, no con productos.id_almacen', async () => {
    // El producto tiene almacenes en dos sucursales distintas; la consulta
    // de conteo y la de datos SIEMPRE filtran por a.id_sucursal = $1, asi
    // que aunque exista otra asignacion en otra sucursal, esta resolucion
    // (para idSucursal=2) solo ve/cuenta la asignacion de esa sucursal.
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 156, total_asignaciones: 1 }] },
      {
        rows: [{
          id_producto: 156,
          nombre_producto: 'SEVEN UP 1.1 LT',
          descripcion_producto: '',
          precio: 48,
          id_archivo_imagen_principal: 227,
          id_almacen: 9,
          cantidad: 40,
          stock_minimo: 5,
          id_sucursal: 2,
          nombre_almacen: 'Almacen 21 de Agosto'
        }]
      }
    ]);

    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 2, productIds: [156] });
    const row = result.get(156);

    assert.equal(row.status, 'OK');
    assert.equal(row.id_sucursal, 2);
    assert.equal(row.id_almacen, 9);
    assert.equal(row.stock_disponible, 35);
    // La resolucion nunca consulta productos.id_almacen: el filtro de
    // sucursal viaja solo en el JOIN con almacenes.
    for (const call of client.calls) {
      assert.doesNotMatch(call.sql, /productos\.id_almacen|p\.id_almacen\b/);
    }
  });

  it('sin ninguna asignacion activa en la sucursal -> SIN_ASIGNACION (sin ejecutar la consulta de datos/lock)', async () => {
    const client = buildAssignmentClient([{ rows: [] }]);
    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [999] });

    assert.deepEqual(result.get(999), { id_producto: 999, status: 'SIN_ASIGNACION' });
    assert.equal(client.calls.length, 1, 'no debe ejecutar la segunda consulta si no hay nada que resolver/bloquear');
  });

  it('mas de una asignacion activa en la misma sucursal -> AMBIGUA (nunca elige la primera ni la de menor id_almacen)', async () => {
    const client = buildAssignmentClient([{ rows: [{ id_producto: 200, total_asignaciones: 2 }] }]);
    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [200] });

    assert.deepEqual(result.get(200), { id_producto: 200, status: 'AMBIGUA' });
    assert.equal(client.calls.length, 1, 'un producto ambiguo no debe intentar bloquearse');
  });

  it('producto inactivo o asignacion/almacen inactivos: el JOIN los excluye, se resuelve como SIN_ASIGNACION', async () => {
    const client = buildAssignmentClient([{ rows: [] }]);
    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [777] });

    assert.equal(result.get(777).status, 'SIN_ASIGNACION');
    const [countCall] = client.calls;
    assert.match(countCall.sql, /COALESCE\(p\.estado, true\) = true/);
    assert.match(countCall.sql, /COALESCE\(pa\.estado, true\) = true/);
    assert.match(countCall.sql, /COALESCE\(a\.estado, true\) = true/);
  });

  it('lockForUpdate=true agrega FOR UPDATE OF pa; lockForUpdate=false (default) no lo agrega', async () => {
    const lockedClient = buildAssignmentClient([
      { rows: [{ id_producto: 1, total_asignaciones: 1 }] },
      { rows: [{ id_producto: 1, nombre_producto: 'X', descripcion_producto: '', precio: 1, id_archivo_imagen_principal: null, id_almacen: 1, cantidad: 1, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'A' }] }
    ]);
    await resolveFidelizacionProductAssignments({ client: lockedClient, idSucursal: 1, productIds: [1], lockForUpdate: true });
    assert.match(lockedClient.calls[1].sql, /FOR UPDATE OF pa/);

    const unlockedClient = buildAssignmentClient([
      { rows: [{ id_producto: 1, total_asignaciones: 1 }] },
      { rows: [{ id_producto: 1, nombre_producto: 'X', descripcion_producto: '', precio: 1, id_archivo_imagen_principal: null, id_almacen: 1, cantidad: 1, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'A' }] }
    ]);
    await resolveFidelizacionProductAssignments({ client: unlockedClient, idSucursal: 1, productIds: [1], lockForUpdate: false });
    assert.doesNotMatch(unlockedClient.calls[1].sql, /FOR UPDATE/);
  });

  it('la consulta usa la forma exacta pedida: productos INNER JOIN productos_almacenes INNER JOIN almacenes con a.id_sucursal = $1', async () => {
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 1, total_asignaciones: 1 }] },
      { rows: [{ id_producto: 1, nombre_producto: 'X', descripcion_producto: '', precio: 1, id_archivo_imagen_principal: null, id_almacen: 1, cantidad: 1, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'A' }] }
    ]);
    await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [1] });

    for (const call of client.calls) {
      assert.match(call.sql, /INNER JOIN public\.almacenes a\s+ON a\.id_almacen = pa\.id_almacen\s+AND a\.id_sucursal = \$1/);
      assert.match(call.sql, /INNER JOIN public\.productos p\s+ON p\.id_producto = pa\.id_producto/);
    }
  });

  it('id_sucursal totalmente no numerico se rechaza sin ejecutar ninguna consulta', async () => {
    const client = buildAssignmentClient([{ rows: [] }]);
    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 'abc', productIds: [1] });
    assert.equal(result.size, 0);
    assert.equal(client.calls.length, 0);
  });

  it('un id_sucursal con texto extra ("1; DROP TABLE ...") se rechaza por completo: NUNCA se trunca a 1 ni ejecuta ninguna consulta', async () => {
    // parseStrictPositiveInt (services/fidelizacionService.js) exige que
    // TODO el valor sean digitos antes de aceptarlo. A diferencia del
    // parser lenient anterior (que truncaba "1; DROP TABLE ..." a 1),
    // este payload se rechaza de raiz: idSucursal queda null y la funcion
    // retorna un Map vacio sin tocar la base de datos. Sigue sin ser una
    // brecha de SQL injection (las consultas parametrizadas ya lo evitaban),
    // pero ahora tampoco es una entrada invalida convertida en una
    // operacion valida distinta.
    const maliciousSucursal = '1; DROP TABLE productos_almacenes; --';
    const client = buildAssignmentClient([{ rows: [] }]);
    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: maliciousSucursal, productIds: [1] });

    assert.equal(result.size, 0);
    assert.equal(client.calls.length, 0, 'un id_sucursal invalido nunca debe generar una consulta, ni siquiera parametrizada');
  });

  it('un producto valido sigue viajando parametrizado (ningun payload se concatena en el texto SQL)', async () => {
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 1, total_asignaciones: 1 }] },
      { rows: [{ id_producto: 1, nombre_producto: 'X', descripcion_producto: '', precio: 1, id_archivo_imagen_principal: null, id_almacen: 1, cantidad: 1, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'A' }] }
    ]);
    await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [1] });

    for (const call of client.calls) {
      assert.match(call.sql, /\$1/);
    }
    assert.deepEqual(client.calls[0].params, [1, [1]]);
    assert.match(client.calls[0].sql, /\$2::int\[\]/);
  });

  it('1.5 en productIds se descarta (NUNCA se trunca a 1): probado en aislamiento, sin un "1" literal que enmascare el resultado', async () => {
    // Bloqueante de integridad: con el parser lenient anterior, 1.5 se
    // truncaba a 1 (Number.parseInt("1.5",10) === 1). parseStrictPositiveInt
    // exige "^\d+$" completo, asi que 1.5 se descarta directamente. Se
    // prueba con 1.5 como UNICO id (sin ningun "1" entero real en la
    // lista) para que la aserción realmente dependa del rechazo estricto,
    // no de una coincidencia con otro id valido ya presente.
    const client = buildAssignmentClient([]);
    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 3, productIds: [1.5] });
    assert.equal(result.size, 0);
    assert.equal(client.calls.length, 0, 'sin ids validos, no debe ejecutarse ninguna consulta');
  });

  it('productIds con valores no numericos, negativos, cero o duplicados se limpian antes de parametrizar (sin agregacion silenciosa incorrecta)', async () => {
    const client = buildAssignmentClient([{ rows: [{ id_producto: 1, total_asignaciones: 1 }] }]);
    await resolveFidelizacionProductAssignments({ client, idSucursal: 3, productIds: [1, 1, 'abc', -5, 0, 1.5, '2 OR 1=1'] });
    assert.deepEqual(client.calls[0].params, [3, [1]], 'solo el entero valido (1, deduplicado) debe llegar al arreglo de parametros');
  });

  it('sin idSucursal o sin productIds devuelve un Map vacio sin consultar la base de datos', async () => {
    const client = buildAssignmentClient([]);
    const r1 = await resolveFidelizacionProductAssignments({ client, idSucursal: null, productIds: [1] });
    const r2 = await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [] });
    assert.equal(r1.size, 0);
    assert.equal(r2.size, 0);
    assert.equal(client.calls.length, 0);
  });
});

// Riesgo de concurrencia confirmado: entre el COUNT(*) GROUP BY (deteccion
// de ambiguedad) y el SELECT ... FOR UPDATE OF pa (fetch con lock), otra
// transaccion puede crear/activar una segunda asignacion. La version
// anterior escribia cada fila del SELECT directamente en resultMap: si
// llegaban 2 filas para el mismo producto, la ULTIMA en el bucle
// sobrescribia a la primera y el producto terminaba como 'OK' con un
// almacen elegido por el orden accidental de PostgreSQL. Estas pruebas
// demuestran que la decision final se basa en las filas REALMENTE
// bloqueadas (agrupadas por id_producto), nunca en el COUNT previo ni en
// "la ultima fila gana".
describe('resolveFidelizacionProductAssignments: la decision final se basa en las filas bloqueadas, no en el COUNT previo ni en el orden de llegada', () => {
  it('COUNT=1 pero el SELECT bloqueado devuelve 2 filas para el mismo producto -> AMBIGUA (nunca "la ultima fila gana")', async () => {
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 156, total_asignaciones: 1 }] },
      {
        rows: [
          { id_producto: 156, nombre_producto: 'X', descripcion_producto: '', precio: 10, id_archivo_imagen_principal: null, id_almacen: 1, cantidad: 100, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'Almacen A' },
          { id_producto: 156, nombre_producto: 'X', descripcion_producto: '', precio: 10, id_archivo_imagen_principal: null, id_almacen: 2, cantidad: 5, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'Almacen B' }
        ]
      }
    ]);

    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [156], lockForUpdate: true });
    const row = result.get(156);

    assert.equal(row.status, 'AMBIGUA');
    // Explicitamente NO debe quedar como 'OK' con los datos de la segunda
    // fila (que es lo que pasaria si el bucle solo sobrescribiera resultMap
    // fila por fila sin agrupar antes).
    assert.notEqual(row.id_almacen, 2);
    assert.equal(row.id_almacen, undefined, 'un resultado AMBIGUA no debe traer id_almacen de ninguna de las dos filas');
  });

  it('COUNT=1 pero el SELECT bloqueado devuelve 0 filas para ese producto -> SIN_ASIGNACION (la asignacion se desactivo entre las dos consultas)', async () => {
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 156, total_asignaciones: 1 }] },
      { rows: [] }
    ]);

    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [156], lockForUpdate: true });
    assert.deepEqual(result.get(156), { id_producto: 156, status: 'SIN_ASIGNACION' });
  });

  it('COUNT=1 y el SELECT bloqueado devuelve exactamente 1 fila -> OK con los datos de esa fila', async () => {
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 156, total_asignaciones: 1 }] },
      { rows: [{ id_producto: 156, nombre_producto: 'X', descripcion_producto: '', precio: 10, id_archivo_imagen_principal: null, id_almacen: 7, cantidad: 50, stock_minimo: 5, id_sucursal: 1, nombre_almacen: 'Almacen C' }] }
    ]);

    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [156], lockForUpdate: true });
    const row = result.get(156);
    assert.equal(row.status, 'OK');
    assert.equal(row.id_almacen, 7);
    assert.equal(row.stock_disponible, 45);
  });

  it('con multiples productos, cada uno se agrupa y resuelve de forma independiente (uno OK, otro AMBIGUA en la misma respuesta)', async () => {
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 1, total_asignaciones: 1 }, { id_producto: 2, total_asignaciones: 1 }] },
      {
        rows: [
          { id_producto: 1, nombre_producto: 'A', descripcion_producto: '', precio: 1, id_archivo_imagen_principal: null, id_almacen: 1, cantidad: 10, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'A' },
          { id_producto: 2, nombre_producto: 'B', descripcion_producto: '', precio: 2, id_archivo_imagen_principal: null, id_almacen: 5, cantidad: 20, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'B1' },
          { id_producto: 2, nombre_producto: 'B', descripcion_producto: '', precio: 2, id_archivo_imagen_principal: null, id_almacen: 6, cantidad: 3, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'B2' }
        ]
      }
    ]);

    const result = await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [1, 2], lockForUpdate: true });
    assert.equal(result.get(1).status, 'OK');
    assert.equal(result.get(1).id_almacen, 1);
    assert.equal(result.get(2).status, 'AMBIGUA');
  });

  it('la consulta con lock incluye ORDER BY pa.id_producto ASC, pa.id_almacen ASC ANTES de FOR UPDATE OF pa', async () => {
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 1, total_asignaciones: 1 }] },
      { rows: [{ id_producto: 1, nombre_producto: 'X', descripcion_producto: '', precio: 1, id_archivo_imagen_principal: null, id_almacen: 1, cantidad: 1, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'A' }] }
    ]);

    await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [1], lockForUpdate: true });

    const lockSql = client.calls[1].sql;
    assert.match(lockSql, /ORDER BY pa\.id_producto ASC, pa\.id_almacen ASC\s+FOR UPDATE OF pa/, 'el ORDER BY determinista debe preceder a FOR UPDATE OF pa (reduce el riesgo de deadlock)');
  });

  it('sin lockForUpdate (listados de solo lectura) el ORDER BY se conserva pero no se agrega FOR UPDATE', async () => {
    const client = buildAssignmentClient([
      { rows: [{ id_producto: 1, total_asignaciones: 1 }] },
      { rows: [{ id_producto: 1, nombre_producto: 'X', descripcion_producto: '', precio: 1, id_archivo_imagen_principal: null, id_almacen: 1, cantidad: 1, stock_minimo: 0, id_sucursal: 1, nombre_almacen: 'A' }] }
    ]);

    await resolveFidelizacionProductAssignments({ client, idSucursal: 1, productIds: [1], lockForUpdate: false });

    const dataSql = client.calls[1].sql;
    assert.match(dataSql, /ORDER BY pa\.id_producto ASC, pa\.id_almacen ASC/);
    assert.doesNotMatch(dataSql, /FOR UPDATE/);
  });
});

// --------------------------------------------------------------------
// createPresentialFidelizacionCanje: fixture completo del flujo real de
// confirmacion de canje (misma tecnica de client simulado, con estado
// mutable para poder simular el trigger de movimientos_inventario y
// escenarios de concurrencia/rollback).
// --------------------------------------------------------------------

const CATALOG_IDS = {
  ACUMULACION: 1,
  CANJE: 2,
  FACTURA: 3,
  REGISTRADO: 4
};

const buildCanjeFixture = (options = {}) => {
  const calls = [];
  const state = {
    clienteActivo: options.clienteActivo ?? true,
    saldo: { puntos_disponibles: options.puntosDisponibles ?? 100, puntos_acumulados_total: 0, puntos_canjeados_total: 0 },
    config: options.config === undefined ? { lempiras_por_punto: 10 } : options.config,
    canjeables: options.canjeables || new Map(),
    assignments: options.assignments || new Map(),
    nextCanjeId: options.nextCanjeId ?? 1,
    nextMovimientoId: 1,
    failOn: options.failOn || null,
    failCode: options.failCode || null
  };

  const query = async (sqlRaw, params = []) => {
    const sql = normalizeSql(sqlRaw);
    calls.push({ sql, params });

    if (state.failOn && sql.includes(state.failOn)) {
      throw Object.assign(new Error('simulated db failure'), { code: state.failCode });
    }

    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };

    if (sql.includes('FROM public.clientes') && sql.includes('COALESCE(estado, true) AS estado')) {
      return { rows: [{ id_cliente: params[0], estado: state.clienteActivo }], rowCount: 1 };
    }

    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };

    if (sql.startsWith('INSERT INTO public.fidelizacion_saldos_cliente')) return { rows: [], rowCount: 0 };

    if (sql.includes('FROM public.fidelizacion_saldos_cliente') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id_cliente: params[0], ...state.saldo }], rowCount: 1 };
    }

    if (sql.includes('FROM public.fidelizacion_configuracion_sucursal')) {
      return { rows: state.config ? [state.config] : [], rowCount: state.config ? 1 : 0 };
    }

    if (sql.includes('FROM public.fidelizacion_productos_canjeables_sucursal') && !sql.includes('DO UPDATE')) {
      const ids = params[1] || [];
      const rows = ids
        .map((id) => {
          const c = state.canjeables.get(Number(id));
          return c ? { id_producto: id, puntos_requeridos_override: c.puntos_requeridos_override ?? null, canjeable_estado: c.canjeable_estado !== false } : null;
        })
        .filter(Boolean);
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM public.productos_almacenes pa') && sql.includes('GROUP BY pa.id_producto')) {
      const ids = params[1] || [];
      const rows = ids
        .map((id) => {
          const a = state.assignments.get(Number(id));
          return a ? { id_producto: id, total_asignaciones: a.total_asignaciones ?? 1 } : null;
        })
        .filter(Boolean);
      return { rows, rowCount: rows.length };
    }

    if (sql.includes('FROM public.productos_almacenes pa') && sql.includes('FOR UPDATE OF pa')) {
      const ids = params[1] || [];
      const rows = ids
        .filter((id) => {
          const a = state.assignments.get(Number(id));
          return a && (a.total_asignaciones ?? 1) === 1;
        })
        .map((id) => {
          const a = state.assignments.get(Number(id));
          return {
            id_producto: id,
            nombre_producto: a.nombre_producto,
            descripcion_producto: a.descripcion_producto || '',
            precio: a.precio,
            id_archivo_imagen_principal: a.id_archivo_imagen_principal ?? null,
            id_almacen: a.id_almacen,
            cantidad: a.cantidad,
            stock_minimo: a.stock_minimo,
            id_sucursal: a.id_sucursal,
            nombre_almacen: a.nombre_almacen
          };
        });
      return { rows, rowCount: rows.length };
    }

    if (
      sql.includes('FROM public.cat_fidelizacion_tipos_movimiento') ||
      sql.includes('FROM public.cat_fidelizacion_origenes_movimiento') ||
      sql.includes('FROM public.cat_fidelizacion_estados_canje')
    ) {
      const code = String(params[0] || '').toUpperCase();
      return { rows: [{ id_catalogo: CATALOG_IDS[code] || 9, codigo: code, nombre: code, estado: true }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO public.fidelizacion_canjes (')) {
      const idCanje = state.nextCanjeId;
      state.nextCanjeId += 1;
      return { rows: [{ id_canje: idCanje }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO public.fidelizacion_canjes_detalle')) return { rows: [], rowCount: 1 };

    if (sql.startsWith('UPDATE public.fidelizacion_saldos_cliente')) {
      state.saldo = {
        puntos_disponibles: Number(params[0]),
        puntos_acumulados_total: Number(params[1]),
        puntos_canjeados_total: Number(params[2])
      };
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE public.clientes')) return { rows: [], rowCount: 1 };

    if (sql.startsWith('INSERT INTO public.fidelizacion_movimientos')) {
      const id = state.nextMovimientoId;
      state.nextMovimientoId += 1;
      return { rows: [{ id_movimiento: id }], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO public.movimientos_inventario')) {
      // Simula el trigger existente: descuenta productos_almacenes.cantidad
      // para el mismo (id_producto, id_almacen) del movimiento SALIDA.
      const cantidadMovida = Number(params[0]);
      const idAlmacen = Number(params[1]);
      const idProducto = Number(params[2]);
      const assignment = state.assignments.get(idProducto);
      if (assignment && Number(assignment.id_almacen) === idAlmacen) {
        assignment.cantidad = Number(assignment.cantidad) - cantidadMovida;
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("to_regclass('public.bitacoras')")) return { rows: [{ reg: null }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO public.bitacoras')) return { rows: [], rowCount: 1 };

    throw new Error(`Consulta no reconocida por el fixture: ${sql}`);
  };

  return { query, calls, state };
};

const baseAssignment = (overrides = {}) => ({
  total_asignaciones: 1,
  nombre_producto: 'CERVEZA ULTRA BOTELLA',
  descripcion_producto: '',
  precio: 45,
  id_archivo_imagen_principal: 88,
  id_almacen: 1,
  cantidad: 100,
  stock_minimo: 10,
  id_sucursal: 1,
  nombre_almacen: "Almacen Jonny's el Carmen",
  ...overrides
});

describe('createPresentialFidelizacionCanje: confirmacion del canje con la asignacion local resuelta', () => {
  it('producto con productos.id_almacen de OTRA sucursal (irrelevante ahora) igual se canjea si tiene asignacion activa en la sucursal del canje', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: null, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment({ id_almacen: 9, id_sucursal: 1, cantidad: 50, stock_minimo: 5 })]])
    });

    const result = await createPresentialFidelizacionCanje({
      client: fixture,
      req: {},
      idCliente: 10,
      idSucursal: 1,
      idUsuarioEjecutor: 5,
      items: [{ id_producto: 156, cantidad: 2 }]
    });

    assert.equal(result.idCanje, 1);
    assert.equal(result.items[0].id_almacen, 9, 'el movimiento debe usar el almacen LOCAL resuelto, no uno legado');
  });

  it('el stock se lee y decrementa desde productos_almacenes (no desde productos)', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment({ cantidad: 20, stock_minimo: 5 })]])
    });

    await createPresentialFidelizacionCanje({
      client: fixture,
      req: {},
      idCliente: 10,
      idSucursal: 1,
      idUsuarioEjecutor: 5,
      items: [{ id_producto: 156, cantidad: 3 }]
    });

    assert.equal(fixture.state.assignments.get(156).cantidad, 17, 'la cantidad de productos_almacenes debe reflejar el descuento del movimiento SALIDA');
  });

  it('producto sin asignacion activa se rechaza con FIDELIZACION_PRODUCTO_SIN_ASIGNACION', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: new Map()
    });

    await assert.rejects(
      createPresentialFidelizacionCanje({
        client: fixture,
        req: {},
        idCliente: 10,
        idSucursal: 1,
        idUsuarioEjecutor: 5,
        items: [{ id_producto: 156, cantidad: 1 }]
      }),
      (error) => {
        assert.equal(error.code, 'FIDELIZACION_PRODUCTO_SIN_ASIGNACION');
        assert.equal(error.httpStatus, 409);
        return true;
      }
    );
  });

  it('asignacion ambigua (mas de un almacen activo en la sucursal) se rechaza con FIDELIZACION_PRODUCTO_ASIGNACION_AMBIGUA', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment({ total_asignaciones: 2 })]])
    });

    await assert.rejects(
      createPresentialFidelizacionCanje({
        client: fixture,
        req: {},
        idCliente: 10,
        idSucursal: 1,
        idUsuarioEjecutor: 5,
        items: [{ id_producto: 156, cantidad: 1 }]
      }),
      (error) => {
        assert.equal(error.code, 'FIDELIZACION_PRODUCTO_ASIGNACION_AMBIGUA');
        assert.equal(error.httpStatus, 409);
        return true;
      }
    );
  });

  it('la consulta de resolucion de asignaciones se ejecuta con FOR UPDATE OF pa', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment()]])
    });

    await createPresentialFidelizacionCanje({
      client: fixture,
      req: {},
      idCliente: 10,
      idSucursal: 1,
      idUsuarioEjecutor: 5,
      items: [{ id_producto: 156, cantidad: 1 }]
    });

    const lockCall = fixture.calls.find((call) => call.sql.includes('FROM public.productos_almacenes pa') && call.sql.includes('FOR UPDATE'));
    assert.ok(lockCall, 'debe existir una consulta con FOR UPDATE OF pa sobre productos_almacenes');
    assert.match(lockCall.sql, /FOR UPDATE OF pa/);
  });

  it('se registra exactamente un movimiento SALIDA por producto, con ref_origen=CANJE, id_producto=maestro e id_almacen=local', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment({ id_almacen: 7 })]])
    });

    await createPresentialFidelizacionCanje({
      client: fixture,
      req: {},
      idCliente: 10,
      idSucursal: 1,
      idUsuarioEjecutor: 5,
      items: [{ id_producto: 156, cantidad: 2 }]
    });

    const movementInserts = fixture.calls.filter((call) => call.sql.startsWith('INSERT INTO public.movimientos_inventario'));
    assert.equal(movementInserts.length, 1, 'debe insertar exactamente un movimiento por producto');
    assert.match(movementInserts[0].sql, /'SALIDA'/);
    assert.match(movementInserts[0].sql, /'CANJE'/);
    assert.equal(movementInserts[0].params[1], 7, 'id_almacen debe ser el almacen local resuelto');
    assert.equal(movementInserts[0].params[2], 156, 'id_producto debe ser el producto maestro');
  });

  it('no existe ningun UPDATE manual de productos_almacenes ni de productos.cantidad desde Node.js (evita doble rebaja)', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment()]])
    });

    await createPresentialFidelizacionCanje({
      client: fixture,
      req: {},
      idCliente: 10,
      idSucursal: 1,
      idUsuarioEjecutor: 5,
      items: [{ id_producto: 156, cantidad: 2 }]
    });

    const forbiddenUpdates = fixture.calls.filter(
      (call) => /UPDATE public\.productos_almacenes/.test(call.sql) || /UPDATE public\.productos\b/.test(call.sql)
    );
    assert.deepEqual(forbiddenUpdates, [], 'la rebaja de stock debe quedar exclusivamente a cargo del trigger existente sobre movimientos_inventario');
  });

  it('dos canjes secuenciales sobre la misma ultima unidad: el segundo recibe stock insuficiente (el mock aplica el mismo efecto que el trigger real tras el primer commit)', async () => {
    // Un solo mapa de asignaciones compartido simula la fila real de
    // productos_almacenes ya actualizada por el trigger despues del primer
    // canje (equivalente a que el FOR UPDATE OF pa del segundo canje vea el
    // valor ya decrementado, que es exactamente lo que impide que ambos
    // canjes consuman la misma ultima unidad).
    const sharedAssignments = new Map([[156, baseAssignment({ cantidad: 11, stock_minimo: 10 })]]); // stock_disponible = 1

    const fixtureA = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: sharedAssignments
    });
    const resultA = await createPresentialFidelizacionCanje({
      client: fixtureA,
      req: {},
      idCliente: 10,
      idSucursal: 1,
      idUsuarioEjecutor: 5,
      items: [{ id_producto: 156, cantidad: 1 }]
    });
    assert.ok(resultA.idCanje);
    assert.equal(sharedAssignments.get(156).cantidad, 10, 'stock_disponible ahora es 0');

    const fixtureB = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: sharedAssignments,
      puntosDisponibles: 100
    });
    await assert.rejects(
      createPresentialFidelizacionCanje({
        client: fixtureB,
        req: {},
        idCliente: 11,
        idSucursal: 1,
        idUsuarioEjecutor: 5,
        items: [{ id_producto: 156, cantidad: 1 }]
      }),
      (error) => {
        assert.equal(error.code, 'FIDELIZACION_STOCK_INSUFFICIENT');
        return true;
      }
    );
  });

  it('un error al insertar el movimiento de inventario propaga el rechazo (el router hace ROLLBACK): no queda saldo/canje/detalle aplicados a medias', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment()]]),
      failOn: 'INSERT INTO public.movimientos_inventario',
      failCode: 'SIMULATED_FAILURE'
    });

    await assert.rejects(
      createPresentialFidelizacionCanje({
        client: fixture,
        req: {},
        idCliente: 10,
        idSucursal: 1,
        idUsuarioEjecutor: 5,
        items: [{ id_producto: 156, cantidad: 1 }]
      }),
      (error) => {
        assert.equal(error.code, 'SIMULATED_FAILURE');
        return true;
      }
    );

    // La funcion ya ejecuto el INSERT de canje, detalle y el descuento de
    // puntos ANTES de fallar en el movimiento: eso es exactamente lo que
    // debe revertir el ROLLBACK del router (createCanje en
    // routers/fidelizacion.js hace client.query('ROLLBACK') en su catch,
    // sin cambios respecto al codigo ya existente).
    assert.ok(fixture.calls.some((call) => call.sql.startsWith('INSERT INTO public.fidelizacion_canjes (')));
    assert.ok(fixture.calls.some((call) => call.sql.startsWith('UPDATE public.fidelizacion_saldos_cliente')));
    assert.ok(!fixture.calls.some((call) => call.sql === 'COMMIT'), 'la funcion nunca hace su propio COMMIT: eso es responsabilidad del router');
  });

  it('puntos insuficientes se rechazan antes de crear el canje (no se llega a insertar nada)', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 50, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment()]]),
      puntosDisponibles: 10
    });

    await assert.rejects(
      createPresentialFidelizacionCanje({
        client: fixture,
        req: {},
        idCliente: 10,
        idSucursal: 1,
        idUsuarioEjecutor: 5,
        items: [{ id_producto: 156, cantidad: 1 }]
      }),
      (error) => {
        assert.equal(error.code, 'FIDELIZACION_SALDO_INSUFICIENTE');
        return true;
      }
    );
    assert.ok(!fixture.calls.some((call) => call.sql.startsWith('INSERT INTO public.fidelizacion_canjes (')));
  });
});

describe('routers/fidelizacion.js: createCanje hace ROLLBACK ante cualquier error (codigo existente, sin debilitar)', () => {
  it('el catch de createCanje ejecuta ROLLBACK y libera el client antes de relanzar', async () => {
    const source = await readFile(new URL('../../routers/fidelizacion.js', import.meta.url), 'utf8');
    const start = source.indexOf('async createCanje(req)');
    const end = source.indexOf('\n  },', start);
    const handler = source.slice(start, end);

    assert.match(handler, /await client\.query\('BEGIN'\);/);
    assert.match(handler, /await client\.query\('COMMIT'\);/);
    const catchIdx = handler.indexOf('} catch (error) {');
    assert.notEqual(catchIdx, -1);
    const catchBlock = handler.slice(catchIdx);
    assert.match(catchBlock, /await client\.query\('ROLLBACK'\);/);
    assert.match(catchBlock, /throw error;/);
    assert.match(handler, /client\.release\(\);/);
  });
});

// Bloqueante de integridad confirmado por la auditoria independiente:
// parsePositiveInt (Number.parseInt) trunca/detiene en el primer caracter
// no numerico -- "156abc" -> 156, "1.5" -> 1, "2 OR 1=1" -> 2 -- por lo que
// una entrada invalida se convertia en silencio en una operacion valida
// distinta (otro id_producto, otra cantidad). No es una brecha de SQL
// injection (las consultas ya estaban parametrizadas), pero si un problema
// de integridad. parseStrictPositiveInt exige que TODO el valor sea un
// entero positivo puro.
describe('parseStrictPositiveInt: entero positivo estricto (Number.isSafeInteger, no solo Number.isInteger)', () => {
  it('acepta enteros y cadenas puramente numericas, incluyendo ceros a la izquierda', () => {
    assert.equal(parseStrictPositiveInt(1), 1);
    assert.equal(parseStrictPositiveInt('1'), 1);
    assert.equal(parseStrictPositiveInt('001'), 1);
  });

  it('rechaza cero, negativos y decimales (numero o cadena)', () => {
    assert.equal(parseStrictPositiveInt(0), null);
    assert.equal(parseStrictPositiveInt('0'), null);
    assert.equal(parseStrictPositiveInt(-1), null);
    assert.equal(parseStrictPositiveInt('-1'), null);
    assert.equal(parseStrictPositiveInt(1.5), null);
    assert.equal(parseStrictPositiveInt('1.5'), null);
  });

  it('rechaza texto parcialmente numerico y fragmentos tipo SQL: nunca se trunca al prefijo numerico', () => {
    assert.equal(parseStrictPositiveInt('156abc'), null);
    assert.equal(parseStrictPositiveInt('2 OR 1=1'), null);
    assert.equal(parseStrictPositiveInt('2;DROP TABLE clientes'), null);
    assert.equal(parseStrictPositiveInt('5x'), null);
  });

  it('rechaza arreglos y objetos explicitamente (String(["1"]) === "1" no debe colar)', () => {
    assert.equal(parseStrictPositiveInt(['1']), null);
    assert.equal(parseStrictPositiveInt({}), null);
    assert.equal(parseStrictPositiveInt({ value: 1 }), null);
  });

  it('rechaza NaN, Infinity y null cuando el campo es obligatorio', () => {
    assert.equal(parseStrictPositiveInt(NaN), null);
    assert.equal(parseStrictPositiveInt(Infinity), null);
    assert.equal(parseStrictPositiveInt(null), null);
    assert.equal(parseStrictPositiveInt(undefined), null);
  });

  it('usa Number.isSafeInteger: un entero mas alla de 2^53-1 se rechaza aunque solo tenga digitos', () => {
    assert.equal(parseStrictPositiveInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    assert.equal(parseStrictPositiveInt(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    // MAX_SAFE_INTEGER + 2 como cadena de puros digitos: Number.isInteger()
    // seguiria devolviendo true (float64 sin parte fraccionaria), pero
    // Number.isSafeInteger() no. Esta es la diferencia que exige el
    // contrato del helper (no basta con Number.isInteger).
    assert.equal(parseStrictPositiveInt(String(Number.MAX_SAFE_INTEGER + 2)), null);
  });
});

// 9.4: createPresentialFidelizacionCanje debe rechazar items invalidos por
// si sola, sin pasar por el router -- defensa en profundidad real, no solo
// aserciones sobre routers/fidelizacion.js. Un client cuyo query() lanza si
// se le llama demuestra que la validacion ocurre ANTES de cualquier
// consulta (aggregateCanjeItems se ejecuta antes de fetchClienteEstado, el
// primer client.query real de la funcion).
describe('createPresentialFidelizacionCanje: articulos invalidos se rechazan antes de cualquier consulta (defensa del servicio, sin router)', () => {
  const clientQueNuncaDebeLlamarse = () => ({
    query: async (sqlRaw) => {
      throw new Error(`No debia ejecutarse ninguna consulta con items invalidos: ${normalizeSql(sqlRaw)}`);
    }
  });

  const invalidItemCases = [
    ['id_producto="156.9"', [{ id_producto: '156.9', cantidad: 1 }]],
    ['cantidad="2.9"', [{ id_producto: 156, cantidad: '2.9' }]],
    ['cantidad="2 OR 1=1"', [{ id_producto: 156, cantidad: '2 OR 1=1' }]],
    ['cantidad=["2"]', [{ id_producto: 156, cantidad: ['2'] }]],
    ['cantidad={}', [{ id_producto: 156, cantidad: {} }]],
    ['cantidad=0', [{ id_producto: 156, cantidad: 0 }]],
    ['cantidad=-1', [{ id_producto: 156, cantidad: -1 }]],
    ['id_producto=["156"]', [{ id_producto: ['156'], cantidad: 1 }]],
    ['id_producto={}', [{ id_producto: {}, cantidad: 1 }]]
  ];

  for (const [label, items] of invalidItemCases) {
    it(`${label} se rechaza con FIDELIZACION_CANJE_ITEM_INVALID antes de tocar el client`, async () => {
      await assert.rejects(
        createPresentialFidelizacionCanje({
          client: clientQueNuncaDebeLlamarse(),
          req: {},
          idCliente: 10,
          idSucursal: 1,
          idUsuarioEjecutor: 5,
          items
        }),
        (error) => {
          assert.equal(error.code, 'FIDELIZACION_CANJE_ITEM_INVALID');
          assert.equal(error.httpStatus, 400);
          return true;
        }
      );
    });
  }

  it('la suma agregada de un producto duplicado que desborda Number.MAX_SAFE_INTEGER se rechaza (no continua con un total incorrecto)', async () => {
    const unsafeChunk = Number.MAX_SAFE_INTEGER - 1;
    await assert.rejects(
      createPresentialFidelizacionCanje({
        client: clientQueNuncaDebeLlamarse(),
        req: {},
        idCliente: 10,
        idSucursal: 1,
        idUsuarioEjecutor: 5,
        items: [
          { id_producto: 156, cantidad: unsafeChunk },
          { id_producto: 156, cantidad: unsafeChunk }
        ]
      }),
      (error) => {
        assert.equal(error.code, 'FIDELIZACION_CANJE_ITEM_INVALID');
        return true;
      }
    );
  });

  it('articulos duplicados validos si se agregan correctamente (id_producto=156 x2 -> cantidad=3)', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 1, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment({ cantidad: 100, stock_minimo: 0 })]])
    });

    const result = await createPresentialFidelizacionCanje({
      client: fixture,
      req: {},
      idCliente: 10,
      idSucursal: 1,
      idUsuarioEjecutor: 5,
      items: [
        { id_producto: 156, cantidad: 1 },
        { id_producto: 156, cantidad: 2 }
      ]
    });

    assert.equal(result.items[0].cantidad, 3);
  });
});

// 9.6: cuando el resultado final de la resolucion es AMBIGUA o
// SIN_ASIGNACION, no debe quedar ningun efecto parcial: ni canje, ni
// detalle, ni descuento de puntos, ni movimiento de inventario.
describe('createPresentialFidelizacionCanje: sin efectos parciales cuando la asignacion es ambigua o no existe', () => {
  const assertNoEffects = (fixture) => {
    assert.ok(!fixture.calls.some((call) => call.sql.startsWith('INSERT INTO public.fidelizacion_canjes (')), 'no debe crearse el canje');
    assert.ok(!fixture.calls.some((call) => call.sql.startsWith('INSERT INTO public.fidelizacion_canjes_detalle')), 'no debe crearse ningun detalle');
    assert.ok(!fixture.calls.some((call) => call.sql.startsWith('UPDATE public.fidelizacion_saldos_cliente')), 'no debe descontarse ningun punto');
    assert.ok(!fixture.calls.some((call) => call.sql.startsWith('INSERT INTO public.movimientos_inventario')), 'no debe insertarse ningun movimiento de inventario');
  };

  it('AMBIGUA: no se crea canje, detalle, descuento de puntos ni movimiento de inventario', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: new Map([[156, baseAssignment({ total_asignaciones: 2 })]])
    });

    await assert.rejects(
      createPresentialFidelizacionCanje({
        client: fixture,
        req: {},
        idCliente: 10,
        idSucursal: 1,
        idUsuarioEjecutor: 5,
        items: [{ id_producto: 156, cantidad: 1 }]
      }),
      { code: 'FIDELIZACION_PRODUCTO_ASIGNACION_AMBIGUA' }
    );

    assertNoEffects(fixture);
  });

  it('SIN_ASIGNACION: no se crea canje, detalle, descuento de puntos ni movimiento de inventario', async () => {
    const fixture = buildCanjeFixture({
      canjeables: new Map([[156, { puntos_requeridos_override: 5, canjeable_estado: true }]]),
      assignments: new Map()
    });

    await assert.rejects(
      createPresentialFidelizacionCanje({
        client: fixture,
        req: {},
        idCliente: 10,
        idSucursal: 1,
        idUsuarioEjecutor: 5,
        items: [{ id_producto: 156, cantidad: 1 }]
      }),
      { code: 'FIDELIZACION_PRODUCTO_SIN_ASIGNACION' }
    );

    assertNoEffects(fixture);
  });
});
