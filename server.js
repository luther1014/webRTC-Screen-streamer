const path = require("path");
const { createServer } = require("./server/appServer");

const publicDir = path.join(__dirname, "public");
const port = 8080;

createServer({ port, publicDir })
  .then(({ ips }) => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
    console.log("LAN viewer URLs:");
    for (const ip of ips) {
      console.log(`  http://${ip}:${port}/view?room=demo`);
    }
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exitCode = 1;
  });
