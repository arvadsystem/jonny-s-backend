import pool from './config/db-connection.js';
import fs from 'fs';

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
    
    fs.writeFileSync('db_schema_output.json', JSON.stringify({ ok: true, data: tables }, null, 2));

    const checkTableResult = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='usuarios_sucursales'`);
    if (checkTableResult.rowCount === 0) {
      await pool.query(`
        CREATE TABLE usuarios_sucursales (
          id_usuario INT NOT NULL REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
          id_sucursal INT NOT NULL REFERENCES sucursales(id_sucursal) ON DELETE CASCADE,
          PRIMARY KEY (id_usuario, id_sucursal)
        );
      `);
      const append = JSON.parse(fs.readFileSync('db_schema_output.json'));
      append.created_usuarios_sucursales = true;
      fs.writeFileSync('db_schema_output.json', JSON.stringify(append, null, 2));
    }

    process.exit(0);
  } catch (e) {
    fs.writeFileSync('db_schema_output.json', JSON.stringify({ ok: false, error: String(e.stack) }, null, 2));
    process.exit(1);
  }
}

check();
