import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool, types } = pg;

types.setTypeParser(1114, (val) => val);
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
  ssl: {
    rejectUnauthorized: false,
  },
});

// Capturar errores inesperados del pool (conexiones idle que mueren)
// para que no crasheen el proceso.
pool.on('error', (err) => {
  console.error('❌ [pool] Error inesperado en conexión idle:', err.message);
});

// Promesa de "readiness": permite que app.js espere la conexión
// antes de aceptar requests.
export const dbReady = pool.connect()
  .then((client) => {
    console.log('✅ ¡Conexión exitosa a Supabase!');
    client.release();
    return true;
  })
  .catch((err) => {
    console.error('❌ Error al conectar con la base de datos:', err.message);
    return false;
  });

export default pool;