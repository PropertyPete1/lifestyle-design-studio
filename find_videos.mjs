import { createPool } from 'mysql2/promise';

const pool = createPool(process.env.DATABASE_URL);

const [cols] = await pool.query('SHOW COLUMNS FROM videos');
console.log('Columns:', cols.map(c => c.Field).join(', '));
const [rows] = await pool.query('SELECT * FROM videos WHERE id IN (30025, 30079)');
for (const r of rows) console.log(JSON.stringify(r));

await pool.end();
