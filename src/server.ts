import { serve } from "@hono/node-server";
import { openDatabase } from "./database.js";
import { createApp } from "./http/app.js";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}
const db = openDatabase();
const app = createApp(db);
const server = serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port },
  (info) => {
    console.log(
      JSON.stringify({
        event: "listening",
        host: "127.0.0.1",
        port: info.port,
      }),
    );
  },
);
server.on("error", () => {
  console.error(JSON.stringify({ event: "server_error" }));
  db.close();
  process.exitCode = 1;
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => {
    db.close();
    process.exit(1);
  }, 5000);
  timeout.unref();
  server.close(() => {
    clearTimeout(timeout);
    db.close();
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
