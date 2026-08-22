// ecosystem.config.js — configuración de PM2
// Ejecutar: pm2 start ecosystem.config.js && pm2 save

module.exports = {
  apps: [
    {
      name:          'carniceria-bot',
      script:        'index.js',
      cwd:           __dirname,

      // Reinicio automático si el proceso cae
      autorestart:   true,
      restart_delay: 5000,    // esperar 5s antes de reiniciar
      max_restarts:  20,

      // No reiniciar si está corriendo más de 10 segundos seguidos
      // (evita bucle infinito si hay un error de arranque)
      min_uptime:    '10s',

      // Logs — PM2 los gestiona automáticamente
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file:    'logs/error.log',
      out_file:      'logs/output.log',
      merge_logs:    true,

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};