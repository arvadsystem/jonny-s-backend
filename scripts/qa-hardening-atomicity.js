import pool from '../config/db-connection.js';

const PLANILLAS_PERMISSIONS = Object.freeze([
  'PLANILLAS_MODULO_VER',
  'PLANILLAS_LISTADO_VER',
  'PLANILLAS_DETALLE_VER',
  'PLANILLAS_GENERAR',
  'PLANILLAS_RECALCULAR',
  'PLANILLAS_ADELANTOS_APLICAR',
  'PLANILLAS_MOVIMIENTO_REGISTRAR',
  'PLANILLAS_MOVIMIENTO_ANULAR',
  'PLANILLAS_CERRAR',
  'PLANILLAS_PAGAR',
  'PLANILLAS_ANULAR',
  'PLANILLAS_AUDITORIA_VER'
]);

const nowKey = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseJsonSafe = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
};

const extractIdFromUnknown = (value, keys = []) => {
  const direct = parsePositiveInt(value);
  if (direct) return direct;

  const parsed = parseJsonSafe(value);
  const parsedDirect = parsePositiveInt(parsed);
  if (parsedDirect) return parsedDirect;
  if (!parsed || typeof parsed !== 'object') return null;

  for (const key of keys) {
    const candidate = parsePositiveInt(parsed[key]);
    if (candidate) return candidate;
  }

  if (parsed.data && typeof parsed.data === 'object') {
    for (const key of keys) {
      const candidate = parsePositiveInt(parsed.data[key]);
      if (candidate) return candidate;
    }
  }

  return null;
};

const runCase = async (name, fn, results) => {
  process.stdout.write(`\n[TEST] ${name} ... `);
  try {
    const meta = await fn();
    results.push({ name, status: 'PASS', meta });
    console.log('PASS');
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error.message });
    console.log('FAIL');
    console.log(`  -> ${error.message}`);
  }
};

const ensureBaseIds = async () => {
  const [sucursalRs, tipoClienteRs] = await Promise.all([
    pool.query('SELECT id_sucursal FROM sucursales ORDER BY id_sucursal ASC LIMIT 1'),
    pool.query('SELECT id_tipo_cliente FROM tipo_cliente ORDER BY id_tipo_cliente ASC LIMIT 1')
  ]);

  const idSucursal = parsePositiveInt(sucursalRs.rows?.[0]?.id_sucursal);
  const idTipoCliente = parsePositiveInt(tipoClienteRs.rows?.[0]?.id_tipo_cliente);

  if (!idSucursal) {
    throw new Error('No existe ninguna sucursal para ejecutar pruebas de atomicidad.');
  }
  if (!idTipoCliente) {
    throw new Error('No existe ningun tipo_cliente para ejecutar pruebas de atomicidad.');
  }

  return { idSucursal, idTipoCliente };
};

const scenarioEmpleadoPersonaNueva = async ({ idSucursal }) => {
  const client = await pool.connect();
  const marker = nowKey();
  const dni = `QAE${marker}`.slice(0, 20);
  try {
    await client.query('BEGIN');

    const personaPayload = {
      nombre: 'QA',
      apellido: `EmpleadoNueva${marker}`.slice(0, 60),
      dni,
      genero: 'M',
      texto_telefono: '9999-9999',
      texto_correo: `qa+emp-nueva-${marker}@example.com`,
      texto_direccion: `Direccion QA ${marker}`
    };

    const personaRs = await client.query('SELECT fn_guardar_persona($1::json) AS resultado', [
      JSON.stringify(personaPayload)
    ]);
    const idPersona = extractIdFromUnknown(personaRs.rows?.[0]?.resultado, ['id_persona', 'id', 'persona_id']);
    if (!idPersona) throw new Error('No se obtuvo id_persona en escenario empleado+persona nueva.');

    const empleadoPayload = {
      id_persona: idPersona,
      id_sucursal: idSucursal,
      salario_base: 12000,
      fecha_ingreso: new Date().toISOString().slice(0, 10),
      cargo: 'QA Tester',
      nombre_referencia: 'Referencia QA',
      telefono_referencia: '8888-8888',
      estado: true
    };

    const empleadoRs = await client.query('SELECT empleados_crear($1::json) AS id_empleado', [
      JSON.stringify(empleadoPayload)
    ]);
    const idEmpleado = parsePositiveInt(empleadoRs.rows?.[0]?.id_empleado);
    if (!idEmpleado) throw new Error('No se obtuvo id_empleado en escenario empleado+persona nueva.');

    const verifyRs = await client.query(
      'SELECT id_empleado, id_persona FROM empleados WHERE id_empleado = $1 LIMIT 1',
      [idEmpleado]
    );
    if (!verifyRs.rows.length) throw new Error('No se encontro empleado creado en transaccion.');

    await client.query('ROLLBACK');
    return { idPersona, idEmpleado };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const scenarioEmpleadoPersonaExistente = async ({ idSucursal }) => {
  const client = await pool.connect();
  const marker = nowKey();
  const dni = `QAEEX${marker}`.slice(0, 20);
  try {
    await client.query('BEGIN');

    const personaPayload = {
      nombre: 'QA',
      apellido: `EmpleadoExistente${marker}`.slice(0, 60),
      dni,
      genero: 'F',
      texto_telefono: '9777-7777',
      texto_correo: `qa+emp-existente-${marker}@example.com`,
      texto_direccion: `Direccion QA existente ${marker}`
    };

    const personaRs = await client.query('SELECT fn_guardar_persona($1::json) AS resultado', [
      JSON.stringify(personaPayload)
    ]);
    const idPersona = extractIdFromUnknown(personaRs.rows?.[0]?.resultado, ['id_persona', 'id', 'persona_id']);
    if (!idPersona) throw new Error('No se obtuvo id_persona base para escenario persona existente.');

    const empleadoPayload = {
      id_persona: idPersona,
      id_sucursal: idSucursal,
      salario_base: 13000,
      fecha_ingreso: new Date().toISOString().slice(0, 10),
      cargo: 'QA Analyst',
      nombre_referencia: 'Ref Existente',
      telefono_referencia: '8777-7777',
      estado: true
    };

    const empleadoRs = await client.query('SELECT empleados_crear($1::json) AS id_empleado', [
      JSON.stringify(empleadoPayload)
    ]);
    const idEmpleado = parsePositiveInt(empleadoRs.rows?.[0]?.id_empleado);
    if (!idEmpleado) throw new Error('No se obtuvo id_empleado en escenario persona existente.');

    await client.query('ROLLBACK');
    return { idPersona, idEmpleado };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const scenarioClientePersonaNueva = async ({ idTipoCliente }) => {
  const client = await pool.connect();
  const marker = nowKey();
  const dni = `QACP${marker}`.slice(0, 20);
  try {
    await client.query('BEGIN');

    const personaPayload = {
      nombre: 'QA',
      apellido: `ClientePersona${marker}`.slice(0, 60),
      dni,
      genero: 'M',
      texto_telefono: '9666-6666',
      texto_correo: `qa+cli-persona-${marker}@example.com`,
      texto_direccion: `Direccion QA cliente persona ${marker}`
    };

    const personaRs = await client.query('SELECT fn_guardar_persona($1::json) AS resultado', [
      JSON.stringify(personaPayload)
    ]);
    const idPersona = extractIdFromUnknown(personaRs.rows?.[0]?.resultado, ['id_persona', 'id', 'persona_id']);
    if (!idPersona) throw new Error('No se obtuvo id_persona para cliente persona.');

    const clientePayload = {
      id_persona: idPersona,
      id_tipo_cliente: idTipoCliente,
      fecha_ingreso: new Date().toISOString().slice(0, 10),
      puntos: 10,
      estado: true
    };

    const clienteRs = await client.query('SELECT fn_guardar_cliente($1::json) AS id_cliente', [
      JSON.stringify(clientePayload)
    ]);
    const idCliente = parsePositiveInt(clienteRs.rows?.[0]?.id_cliente);
    if (!idCliente) throw new Error('No se obtuvo id_cliente para cliente persona.');

    await client.query('ROLLBACK');
    return { idPersona, idCliente };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const scenarioClienteEmpresaNueva = async ({ idTipoCliente }) => {
  const client = await pool.connect();
  const marker = nowKey();
  const rtn = `QAE${marker}`.slice(0, 20);
  try {
    await client.query('BEGIN');

    const empresaPayload = {
      nombre_empresa: `Empresa QA ${marker}`.slice(0, 120),
      rtn,
      texto_telefono: '9555-5555',
      texto_correo: `qa+cli-empresa-${marker}@example.com`,
      texto_direccion: `Direccion QA empresa ${marker}`
    };

    const empresaRs = await client.query('SELECT fn_guardar_empresa($1::json) AS id_empresa', [
      JSON.stringify(empresaPayload)
    ]);
    const idEmpresa = parsePositiveInt(empresaRs.rows?.[0]?.id_empresa);
    if (!idEmpresa) throw new Error('No se obtuvo id_empresa para cliente empresa.');

    const clientePayload = {
      id_empresa: idEmpresa,
      id_tipo_cliente: idTipoCliente,
      fecha_ingreso: new Date().toISOString().slice(0, 10),
      puntos: 0,
      estado: true
    };

    const clienteRs = await client.query('SELECT fn_guardar_cliente($1::json) AS id_cliente', [
      JSON.stringify(clientePayload)
    ]);
    const idCliente = parsePositiveInt(clienteRs.rows?.[0]?.id_cliente);
    if (!idCliente) throw new Error('No se obtuvo id_cliente para cliente empresa.');

    await client.query('ROLLBACK');
    return { idEmpresa, idCliente };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const scenarioRollbackEmpleado = async ({ idSucursal }) => {
  const client = await pool.connect();
  const marker = nowKey();
  const dni = `QAR${marker}`.slice(0, 20);
  let forcedError = null;

  try {
    await client.query('BEGIN');

    const personaPayload = {
      nombre: 'QA',
      apellido: `Rollback${marker}`.slice(0, 60),
      dni,
      genero: 'F',
      texto_telefono: '9444-4444',
      texto_correo: `qa+rollback-${marker}@example.com`,
      texto_direccion: `Direccion rollback ${marker}`
    };

    const personaRs = await client.query('SELECT fn_guardar_persona($1::json) AS resultado', [
      JSON.stringify(personaPayload)
    ]);
    const idPersona = extractIdFromUnknown(personaRs.rows?.[0]?.resultado, ['id_persona', 'id', 'persona_id']);
    if (!idPersona) throw new Error('No se obtuvo id_persona en escenario rollback.');

    try {
      await client.query('SELECT empleados_crear($1::json) AS id_empleado', [
        JSON.stringify({
          id_persona: idPersona,
          id_sucursal: idSucursal + 999999,
          salario_base: 10000,
          fecha_ingreso: new Date().toISOString().slice(0, 10),
          cargo: 'Debe fallar',
          estado: true
        })
      ]);
    } catch (error) {
      forcedError = error;
    }

    if (!forcedError) {
      throw new Error('No se provocó error intencional en la segunda fase del flujo.');
    }

    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const orphanRs = await pool.query(
    `
      SELECT
        p.id_persona
      FROM personas p
      LEFT JOIN empleados e ON e.id_persona = p.id_persona
      LEFT JOIN clientes c ON c.id_persona = p.id_persona
      WHERE p.dni = $1
        AND e.id_persona IS NULL
        AND c.id_persona IS NULL
      LIMIT 1
    `,
    [dni]
  );

  const existsRs = await pool.query('SELECT id_persona FROM personas WHERE dni = $1 LIMIT 1', [dni]);
  if (existsRs.rows.length > 0) {
    throw new Error(
      `Rollback fallido: la persona con dni=${dni} quedó persistida (id_persona=${existsRs.rows[0].id_persona}).`
    );
  }

  return {
    rollback_error_code: forcedError?.code || 'UNKNOWN',
    orphan_query_result: orphanRs.rows.length
  };
};

const verifyPlanillasPermissions = async () => {
  const permsRs = await pool.query(
    'SELECT nombre_permiso FROM permisos WHERE nombre_permiso = ANY($1::text[])',
    [PLANILLAS_PERMISSIONS]
  );
  const found = new Set(permsRs.rows.map((row) => String(row.nombre_permiso || '').trim().toUpperCase()));
  const missing = PLANILLAS_PERMISSIONS.filter((name) => !found.has(name));

  const rolesRs = await pool.query(
    `
      SELECT id_rol, nombre
      FROM roles
      WHERE LOWER(TRIM(nombre)) IN ('administrador', 'super_admin')
      ORDER BY id_rol ASC
    `
  );

  const assignmentRs = await pool.query(
    `
      SELECT r.nombre AS role_name, p.nombre_permiso
      FROM roles r
      JOIN roles_permisos rp ON rp.id_rol = r.id_rol
      JOIN permisos p ON p.id_permiso = rp.id_permiso
      WHERE LOWER(TRIM(r.nombre)) IN ('administrador', 'super_admin')
        AND p.nombre_permiso = ANY($1::text[])
    `,
    [PLANILLAS_PERMISSIONS]
  );

  const byRole = new Map();
  rolesRs.rows.forEach((row) => byRole.set(row.nombre, new Set()));
  assignmentRs.rows.forEach((row) => {
    if (!byRole.has(row.role_name)) return;
    byRole.get(row.role_name).add(row.nombre_permiso);
  });

  const missingByRole = {};
  for (const [roleName, assignedSet] of byRole.entries()) {
    const missingForRole = PLANILLAS_PERMISSIONS.filter((perm) => !assignedSet.has(perm));
    if (missingForRole.length) {
      missingByRole[roleName] = missingForRole;
    }
  }

  const hasRoleGaps = Object.keys(missingByRole).length > 0;
  if (missing.length || hasRoleGaps) {
    throw new Error(
      `Permisos PLANILLAS incompletos en DB. missing_permissions=${JSON.stringify(missing)} missing_by_role=${JSON.stringify(missingByRole)}`
    );
  }

  return {
    missing_permissions: [],
    missing_by_role: {}
  };
};

const main = async () => {
  const results = [];
  try {
    const base = await ensureBaseIds();
    console.log('==============================================');
    console.log('QA Hardening Atomicidad (Personas/Clientes/Empleados)');
    console.log('==============================================');
    console.log(`Base detectada: id_sucursal=${base.idSucursal}, id_tipo_cliente=${base.idTipoCliente}`);

    await runCase('crear empleado con persona nueva', () => scenarioEmpleadoPersonaNueva(base), results);
    await runCase('crear empleado con persona existente', () => scenarioEmpleadoPersonaExistente(base), results);
    await runCase('crear cliente con persona nueva', () => scenarioClientePersonaNueva(base), results);
    await runCase('crear cliente con empresa nueva', () => scenarioClienteEmpresaNueva(base), results);
    await runCase(
      'rollback forzado (persona creada + falla empleado) y anti-huerfanos',
      () => scenarioRollbackEmpleado(base),
      results
    );
    await runCase('verificacion permisos PLANILLAS_* en DB/roles', verifyPlanillasPermissions, results);

    console.log('\n==============================================');
    console.log('RESULTADOS');
    console.log('==============================================');
    results.forEach((item) => {
      console.log(`- ${item.status}: ${item.name}`);
      if (item.status === 'FAIL') {
        console.log(`  error: ${item.error}`);
      } else if (item.meta) {
        console.log(`  meta: ${JSON.stringify(item.meta)}`);
      }
    });

    const failed = results.filter((item) => item.status === 'FAIL');
    if (failed.length) {
      console.error(`\nQA FINAL: FAIL (${failed.length} caso(s) fallaron)`);
      process.exitCode = 1;
      return;
    }

    console.log('\nQA FINAL: PASS (todos los casos ejecutados correctamente)');
  } catch (error) {
    console.error('\nQA FINAL: ERROR no controlado');
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
};

main();
