# Impresion por agente local y sucursal

## Arquitectura

`Navegador -> HTTPS -> backend -> trabajos_impresion -> agente de la sucursal -> wss://localhost:8181 -> QZ Tray -> impresora`.

El navegador nunca necesita QZ en `VITE_PRINT_MODE=agent`. La venta se confirma antes de encolar y no se revierte si la impresion falla. La funcion PostgreSQL `reclamar_trabajos_impresion` usa `FOR UPDATE SKIP LOCKED`, toma como maximo un trabajo, asigna un lease y deriva la sucursal desde el agente autenticado. Un lease vencido permite recuperar un trabajo que no llego a la barrera de despacho. Los fallos se reprograman con backoff acotado hasta `max_intentos`; despues quedan `fallido`. La unicidad `(id_sucursal, idempotency_key, tipo_documento)` evita duplicados.

Antes de cruzar la barrera, el agente valida QZ/impresora y persiste `prepared`. Despues mueve el backend a `confirmacion_pendiente`, persiste `dispatch_started` inmediatamente antes de `qz.print` y, tras una respuesta QZ exitosa, cambia el journal a `printed_unconfirmed`. Un reinicio desde `prepared` consulta el estado remoto y puede continuar una sola vez; `dispatch_started` nunca reimprime automaticamente; `printed_unconfirmed` solo reintenta `complete`. Los ambiguos quedan en cuarentena sin bloquear trabajos posteriores y el log se emite una sola vez por proceso. Esta estrategia prioriza evitar duplicados fisicos; no ofrece ni afirma semantica exactly-once.

Se eligio un endpoint web autenticado e idempotente despues de confirmar la venta porque el alta actual ocurre en una RPC PostgreSQL versionada. Acoplar la cola a esa RPC habria ampliado la transaccion financiera y el alcance de la migracion. El endpoint conserva la regla esencial: la venta ya confirmada nunca espera ni depende de la impresora.

El certificado publico y la clave privada de firma QZ siguen centralizados en el backend. El agente solo recibe el certificado publico y firmas puntuales. El TLS/WSS de QZ Tray en localhost es independiente.

## Migracion y backend QA

Aplicar manualmente en QA `sql/2026-07-16_cola_impresion_agentes_sucursal.sql`. No fue ejecutada por Codex. La migracion habilita RLS sin politicas de Data API y revoca tablas, secuencias y funcion a `anon`, `authenticated` y `service_role`. El backend usa `pg.Pool` con conexion PostgreSQL directa (`DB_USER`); el propietario conserva sus privilegios y no se agrega ningun `GRANT` a roles web. Ejecutar las consultas de RLS, ACL, funcion, indices, constraints y hash al final del archivo.

Variables de backend existentes:

```env
QZ_TRAY_CERTIFICATE_PATH=/run/secrets/qz/digital-certificate.txt
QZ_TRAY_PRIVATE_KEY_PATH=/run/secrets/qz/private-key.pem
QZ_SIGNATURE_ALGORITHM=SHA512
TRUST_PROXY=true
NODE_ENV=production
```

La clave privada permanece en el administrador de secretos de Easypanel. No crear un certificado por sucursal.

Endpoints web autenticados:

- `POST /ventas/:id/print-jobs`: encola factura o comanda; exige permiso e idempotencia para reimpresion.
- `GET /ventas/print-jobs/:id`: estado aislado por alcance de sucursal.

Endpoints del agente, todos bajo `/api/print-agent`, HTTPS, rate limit y credencial propia:

- `POST /heartbeat`
- `POST /jobs/claim`
- `GET /jobs/:id/status` (solo lectura minima dentro de la sucursal del agente)
- `POST /jobs/:id/printing`
- `POST /jobs/:id/confirmation-pending`
- `POST /jobs/:id/lease`
- `POST /jobs/:id/complete`
- `POST /jobs/:id/fail`
- `GET /qz/certificate`
- `POST /qz/sign`

La firma QZ del agente no es un firmador generico. Solo admite:

- `printers.find`, con consulta nula y un trabajo del agente en `imprimiendo` o `confirmacion_pendiente`;
- `print`, una copia HTML/pixel de 58 u 80 mm cuyo `jobName`, ancho y HTML determinista coinciden exactamente con el payload del trabajo en `confirmacion_pendiente`.

QZ Tray 2.2.6 entrega a `setSignaturePromise` el digest SHA-256 hexadecimal del JSON canonico `{call,params,timestamp}`. El backend recalcula ese SHA-256 y lo compara timing-safe; despues firma el digest recibido mediante RSA-SHA512, que sigue siendo el algoritmo configurado en QZ. La autorizacion guarda impresora y firma. Un reintento identico dentro de la ventana devuelve la misma firma; un `print` distinto para el mismo agente/trabajo se rechaza. `printers.find` admite como maximo cinco autorizaciones por minuto y su unicidad incluye agente, trabajo y llamada, evitando colisiones globales.

Retencion: eliminar diariamente autorizaciones vencidas con una tarea operativa controlada, por ejemplo `DELETE FROM public.firmas_qz_agente_solicitudes WHERE expira_at < now() - interval '7 days';`. Esta limpieza no fue instalada ni ejecutada durante la correccion.

Rutas administrativas protegidas por autenticacion, sesion activa, CSRF, auditoria global, `VENTAS_IMPRIMIR`, rol `ADMIN`/`ADMINISTRADOR`/`SUPER_ADMIN` y alcance de sucursal:

- `GET /ventas/print-jobs/ambiguous?id_sucursal=...`
- `GET /ventas/print-jobs/:id/events`
- `POST /ventas/print-jobs/:id/resolve-printed`, con `motivo` obligatorio.
- `POST /ventas/print-jobs/:id/resolve-not-printed`, con `motivo` obligatorio; es la unica ruta que puede reencolar despues de la barrera.

## Frontend

```env
VITE_PRINT_MODE=agent
```

En el build Docker/Easypanel debe declararse el argumento de build `VITE_PRINT_MODE=agent`. El Dockerfile lo convierte explicitamente en `ENV` durante `vite build`; una variable configurada solo en runtime del contenedor nginx no modifica el bundle. El valor predeterminado sigue siendo `direct` cuando el argumento no se proporciona.

En `agent`, ventas y reimpresiones encolan por HTTPS; no hay deteccion ni conexion QZ desde el navegador. En `direct`, se conserva temporalmente el flujo QZ/navegador actual. Rollback: cambiar a `VITE_PRINT_MODE=direct` y reconstruir el frontend. Ninguna variable Vite contiene secretos.

## Registrar y revocar agentes

1. Tras aplicar la migracion, ejecutar localmente en un entorno seguro:
   `cd print-agent; npm run credential:generate -- <ID_SUCURSAL> "Servidor impresion sucursal"`.
2. Guardar el token mostrado una sola vez en el gestor seguro de la PC.
3. Ejecutar el `INSERT` parametrizado indicado por el script mediante el proceso administrativo de QA. No pegar el token: solo se almacena SHA-256 de un token aleatorio de 384 bits.
4. Revocar sin borrar auditoria:
   `UPDATE agentes_impresion SET estado='revocado', fecha_revocacion=now(), fecha_actualizacion=now() WHERE id_agente=$1;`.

## Variables del agente

Consulte `print-agent/.env.example`. Son obligatorias `API_BASE_URL`, `PRINT_AGENT_ID`, `PRINT_AGENT_TOKEN`, `BRANCH_ID` y `PRINTER_MAP_JSON`. `QZ_HOST` solo acepta localhost/loopback y `QZ_SECURE_PORT` por defecto es 8181. `BRANCH_ID` debe coincidir con la identidad provisionada; el backend vuelve a imponer ese alcance. `PRINT_STATE_FILE` guarda el journal local y debe estar en disco persistente de la PC.

Para la CA/certificado TLS local de QZ configure `QZ_CA_CERT_PATH` con un PEM publico instalado solo en la PC servidor. Alternativamente puede establecer `NODE_EXTRA_CA_CERTS` como variable de sistema antes de iniciar Node. El agente valida que exista, que sea X.509, que no contenga claves privadas y que sea valido para `localhost` mediante SAN o la alternativa aceptada por la verificacion de hostname de Node. La conexion TLS vuelve a verificar cadena y hostname con `rejectUnauthorized=true`. Nunca use `rejectUnauthorized=false`, no use `ws://8182` y no suba el certificado al repositorio.

Ejemplo de mapeo (reemplace nombres localmente):

```env
PRINTER_MAP_JSON={"factura":"Nombre Windows","cocina":"Nombre Cocina","caja":"Nombre Caja"}
```

## Instalacion: El Carmen

1. En la PC designada, instalar Node.js 20+, QZ Tray 2.2.6 y drivers; generar/configurar el certificado TLS local para el nombre `localhost`.
2. Mantener puertos 8181/8182 cerrados a la red; QZ solo se usa por localhost.
3. Copiar `print-agent`, ejecutar `npm.cmd install --omit=dev` y crear `.env` fuera de Git.
4. Provisionar agente con el ID real de El Carmen. No configurar `192.168.2.90`; no se usa.
5. Abrir QZ, validar nombres con Windows y completar `PRINTER_MAP_JSON`.
6. Desde PowerShell administrador ejecutar `windows/Install-PrintAgent.ps1`.
7. Confirmar heartbeat y realizar una venta QA. No ejecutar pruebas fisicas desde Codex.

Para 21 de Agosto se repiten los mismos pasos con su `BRANCH_ID`, un agente/token nuevo y sus nombres de impresora. No se cambia codigo.

## Operacion Windows

- Instalar/iniciar: `windows/Install-PrintAgent.ps1`.
- Reiniciar: `windows/Restart-PrintAgent.ps1`.
- Detener: `windows/Stop-PrintAgent.ps1`.
- Desinstalar: `windows/Uninstall-PrintAgent.ps1`.
- Localizar logs: `windows/Get-PrintAgentLogs.ps1`.

Los scripts verifican administrador, Node, `.env` y disponibilidad de QZ. `node-windows` se instala desde npm; no se incluyen binarios externos en Git. El lock de proceso evita dos instancias desde el mismo directorio.

## Diagnostico

Consultar `trabajos_impresion` por `id_sucursal`, `estado`, `intentos`, `lease_expires_at` y `error_sanitizado`; luego revisar `trabajos_impresion_eventos`, heartbeat, el journal y logs JSON del agente. Un trabajo `asignado/imprimiendo` con lease vencido se recupera en el siguiente claim. `confirmacion_pendiente` nunca acepta `fail` ni vuelve automaticamente a `pendiente`: un administrador debe confirmar fisicamente `impreso` o `no impreso`, indicando motivo. El agente consulta el estado y limpia su journal cuando la resolucion ya es final o el trabajo fue reencolado manualmente.

Pasos manuales por PC: instalar QZ/Node/drivers, generar y confiar la configuracion TLS local de QZ para SAN `localhost` segun su instalador oficial, crear `.env`, mapear impresoras, instalar el servicio y custodiar el token. Repetir el mismo requisito de SAN `localhost` en El Carmen y posteriormente en 21 de Agosto. No modificar `hosts`, no instalar certificados en telefonos/tablets y no abrir acceso entrante desde Internet.

## Rollback y limites

El modo directo queda como rollback temporal. La migracion es aditiva; el rollback operativo consiste en revocar agentes y volver el frontend a `direct`. No eliminar tablas con historial. La cola requiere que la migracion se aplique antes de activar `agent` en QA.
