import pool from './config/db-connection.js';

async function check() {
  try {
    const res = await pool.query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name IN ('usuarios_sucursales', 'menu', 'menu_vigente', 'combos', 'recetas', 'productos')
    `);
    
    const tables = {};
    for (const row of res.rows) {
      if (!tables[row.table_name]) tables[row.table_name] = [];
      tables[row.table_name].push(`${row.column_name} (${row.data_type})`);
    }
    
    console.log(JSON.stringify(tables, null, 2));

    const checkTableResult = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='usuarios_sucursales'`);
    if (checkTableResult.rowCount === 0) {
      console.log('Creando tabla usuarios_sucursales...');
      await pool.query(`
        CREATE TABLE usuarios_sucursales (
          id_usuario INT NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
          id_sucursal INT NOT NULL REFERENCES sucursales(id_sucursal) ON DELETE CASCADE,
          PRIMARY KEY (id_usuario, id_sucursal)
        );
      `);
      console.log('Tabla usuarios_sucursales creada.');
    }

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

check();
