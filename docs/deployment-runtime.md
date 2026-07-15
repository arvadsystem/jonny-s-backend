# Runtime de despliegue

## Servicio web

```env
PROCESS_ROLE=web
DB_POOL_MAX=5
EMAIL_SCHEDULER_ENABLED=false
PORT=3001
```

Start command permitido:

```text
vacio
npm start
node bootstrap.js
```

Prohibido:

```text
node app.js
```

Health check:

```text
/health/ready
```

Restart policy:

```text
always
```

## Servicio scheduler

```env
PROCESS_ROLE=scheduler
DB_POOL_MAX=2
EMAIL_SCHEDULER_ENABLED=true
EMAIL_SCHEDULER_INTERVAL_MS=15000
```

Tambien requiere variables:

```text
PostgreSQL
SMTP
campanas
```

Configuracion:

```text
sin dominio
sin proxy HTTP
sin health check de puerto 3001
restart policy always
una sola replica
```

No desplegar dos replicas scheduler sin implementar coordinacion distribuida.

La imagen compartida no define `HEALTHCHECK` en el Dockerfile porque el mismo artefacto corre como `web` y como `scheduler`. Configure el health check solo en EasyPanel para el servicio web.
