const pg = require('pg');

const pool = new pg.Pool({
  host: 'aws-1-us-east-1.pooler.supabase.com',
  port: 6543,
  user: 'postgres.psftuzrisazipmjolaor',
  password: 'vd4JgBFHY4ZDZ._',
  database: 'postgres',
  ssl: {
    rejectUnauthorized: false,
  },
});

async function run() {
  try {
    const res = await pool.query(
      "SELECT nombre_permiso FROM permisos WHERE nombre_permiso IN ('COCINA_PEDIDO_INICIAR', 'COCINA_PEDIDO_MARCAR_LISTO', 'COCINA_PEDIDO_ENTREGAR')"
    );
    console.log('EXISTING_PERMS:', res.rows.map(r => r.nombre_permiso));
    
    if (res.rows.length < 3) {
      console.log('Inserting missing permissions...');
      await pool.query(`
        INSERT INTO permisos (nombre_permiso, descripcion, id_modulo)
        VALUES 
          ('COCINA_PEDIDO_INICIAR', 'Permite empezar a preparar un pedido', (SELECT id_modulo FROM modulos WHERE nombre_modulo = 'COCINA' LIMIT 1)),
          ('COCINA_PEDIDO_MARCAR_LISTO', 'Permite marcar un pedido como listo para entrega', (SELECT id_modulo FROM modulos WHERE nombre_modulo = 'COCINA' LIMIT 1)),
          ('COCINA_PEDIDO_ENTREGAR', 'Permite entregar un pedido al cliente', (SELECT id_modulo FROM modulos WHERE nombre_modulo = 'COCINA' LIMIT 1))
        ON CONFLICT (nombre_permiso) DO NOTHING;
      `);
      console.log('Inserted missing permissions.');
    } else {
      console.log('All permissions exist.');
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
run();
