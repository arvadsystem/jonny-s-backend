import pg from 'pg';

const { Pool, types } = pg;

/**
 * ✅ FIX DEFINITIVO:
 * - timestamp without time zone (OID 1114) -> devolverlo como STRING
 * - date (OID 1082) -> devolverlo como STRING
 *
 * Así evitamos que node-postgres lo convierta a Date (y meta zona horaria),
 * que es lo que causa el desfase y el cambio de día.
 */
types.setTypeParser(1114, (val) => val);
types.setTypeParser(1082, (val) => val);

// Configuración de la conexión a Supabase
const pool = new Pool({
  host: 'aws-1-us-east-1.pooler.supabase.com',
  port: 6543,
  user: 'postgres.psftuzrisazipmjolaor',
  password: 'vd4JgBFHY4ZDZ._',
  database: 'postgres',
  ssl: {
    rejectUnauthorized: false,
  },
});

// Probamos la conexión inmediatamente
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error al conectar con la base de datos:', err.stack);
  } else {
    console.log('¡Conexión exitosa a Supabase!');
    release(); // Liberamos el cliente
  }
});

// Exportamos la conexión para usarla en app.js
export default pool;