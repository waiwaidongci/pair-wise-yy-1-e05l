const http = require("http");
const path = require("path");
const { JsonFileStore } = require("./src/store");
const { createHandlers } = require("./src/handlers");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const store = new JsonFileStore(DB_FILE);
const server = http.createServer(createHandlers(store));

store.read().then(() => {
  server.listen(PORT, () => {
    console.log(`Balance & hairspring review bench API running at http://127.0.0.1:${PORT} (db: ${DB_FILE})`);
  });
});
