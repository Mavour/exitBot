module.exports = {
  apps: [
    {
      name: "dlmm-exit-agent",
      script: "dist/index.js",
      watch: false,
      autorestart: false,
      restart_delay: 3000,
      max_restarts: 5,
      env: { NODE_ENV: "production" },
    },
    {
      name: "dlmm-exit-listener",
      script: "dist/listener.js",
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 50,
      env: { NODE_ENV: "production" },
    },
  ],
};
