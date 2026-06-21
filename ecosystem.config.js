module.exports = {
  apps: [
    {
      name: "dlmm-exit-agent",
      script: "dist/index.js",
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
