import { pool, migrate } from "./db.mjs";
import { createApp } from "./app.mjs";
await migrate();
const server = createApp(pool).listen(process.env.PORT || 4300, "0.0.0.0", () =>
  console.log("Northline Booking API ready."),
);
const cleanup = setInterval(() => {
  void pool
    .query("DELETE FROM workspaces WHERE expires_at<now()")
    .catch(() => {});
  void pool
    .query("DELETE FROM usage_limits WHERE expires_at<now()")
    .catch(() => {});
}, 3600000);
cleanup.unref();
process.on("SIGTERM", () =>
  server.close(() => {
    void pool.end();
  }),
);
