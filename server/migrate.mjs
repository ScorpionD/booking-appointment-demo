import { pool, migrate } from "./db.mjs";
await migrate();
console.log("Booking schema ready.");
await pool.end();
