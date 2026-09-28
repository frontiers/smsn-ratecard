// Run with pm2 from the project folder:  pm2 start deploy/ecosystem.config.cjs && pm2 save
const path = require("path");
module.exports = {
  apps: [
    {
      name: "samansamnuek-proposals",
      script: "server.js",
      cwd: path.join(__dirname, ".."),
      env: { NODE_ENV: "production" },
    },
  ],
};
