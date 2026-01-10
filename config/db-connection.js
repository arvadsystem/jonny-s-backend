import pg from 'pg';

const { Pool } = pg;

// Configuración de la conexión a Supabase
const pool = new Pool({
    host: 'aws-1-us-east-1.pooler.supabase.com',
    port: 6543,
    user: 'postgres.psftuzrisazipmjolaor',
    password: 'vd4JgBFHY4ZDZ._',
    database: 'postgres',
    ssl: {
        rejectUnauthorized: false
    }
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