# Impresion por agente local y sucursal

## Arquitectura

`Navegador -> HTTPS -> backend -> trabajos_impresion -> agente de la sucursal -> wss://localhost:8181 -> QZ Tray -> impresora`.

El navegador nunca necesita QZ en `VITE_PRINT_MODE=agent`. La venta se confirma antes de encolar y no se revierte si la impresion falla. La funcion PostgreSQL `reclamar_trabajos_impresion` usa `FOR UPDATE SKIP LOCKED`, asigna un lease y deriva la sucursal desde el agente autenticado. Un lease vencido permite recuperar un trabajo. Los fallos se reprograman con backoff acotado hasta `max_intentos`; despues quedan `fallido`. La unicidad `(id_sucursal, idempotency_key, tipo_documento)` evita duplicados.

Se eligio un endpoint web autenticado e idempotente despues de confirmar la venta porque el alta actual ocurre en una RPC PostgreSQL versionada. Acoplar la cola a esa RPC habria ampliado la transaccion financiera y el alcance de la migracion. El endpoint conserva la regla esencial: la venta ya confirmada nunca espera ni depende de la impresora.

El certificado publico y la clave privada de firma QZ siguen centralizados en el backend. El agente solo recibe el certificado publico y firmas puntuales. El TLS/WSS de QZ Tray en localhost es independiente.

## Migracion y backend QA

Aplicar manualmente en QA `sql/2026-07-16_cola_impresion_agentes_sucursal.sql`. No fue ejecutada por Codex. Verificar las tres tablas y la funcion con las consultas al final del archivo.

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
- `POST /jobs/:id/printing`
- `POST /jobs/:id/lease`
- `POST /jobs/:id/complete`
- `POST /jobs/:id/fail`
- `GET /qz/certificate`
- `POST /qz/sign`

## Frontend

```env
VITE_PRINT_MODE=agent
```

En `agent`, ventas y reimpresiones encolan por HTTPS; no hay deteccion ni conexion QZ desde el navegador. En `direct`, se conserva temporalmente el flujo QZ/navegador actual. Rollback: cambiar a `VITE_PRINT_MODE=direct` y reconstruir el frontend. Ninguna variable Vite contiene secretos.

## Registrar y revocar agentes

1. Tras aplicar la migracion, ejecutar localmente en un entorno seguro:
   `cd print-agent; npm run credential:generate -- <ID_SUCURSAL> "Servidor impresion sucursal"`.
2. Guardar el token mostrado una sola vez en el gestor seguro de la PC.
3. Ejecutar el `INSERT` parametrizado indicado por el script mediante el proceso administrativo de QA. No pegar el token: solo se almacena SHA-256 de un token aleatorio de 384 bits.
4. Revocar sin borrar auditoria:
   `UPDATE agentes_impresion SET estado='revocado', fecha_revocacion=now(), fecha_actualizacion=now() WHERE id_agente=$1;`.

## Variables del agente

Consulte `print-agent/.env.example`. Son obligatorias `API_BASE_URL`, `PRINT_AGENT_ID`, `PRINT_AGENT_TOKEN`, `BRANCH_ID` y `PRINTER_MAP_JSON`. `QZ_HOST` solo acepta localhost/loopback y `QZ_SECURE_PORT` por defecto es 8181. `BRANCH_ID` debe coincidir con la identidad provisionada; el backend vuelve a imponer ese alcance.

Ejemplo de mapeo (reemplace nombres localmente):

```env
PRINTER_MAP_JSON={"factura":"Nombre Windows","cocina":"Nombre Cocina","caja":"Nombre Caja"}
```

## Instalacion: El Carmen

1. En la PC designada, instalar Node.js 20+, QZ Tray 2.2.6 y drivers.
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

Consultar `trabajos_impresion` por `id_sucursal`, `estado`, `intentos`, `lease_expires_at` y `error_sanitizado`; luego revisar `trabajos_impresion_eventos`, heartbeat y logs JSON del agente. Un trabajo `asignado/imprimiendo` con lease vencido se recupera en el siguiente claim. Un `fallido` requiere una reimpresion controlada desde la UI con una nueva clave de idempotencia.

Pasos manuales por PC: instalar QZ/Node/drivers, confiar la configuracion TLS local de QZ según su instalador oficial, crear `.env`, mapear impresoras, instalar el servicio y custodiar el token. No modificar `hosts`, no instalar certificados en telefonos/tablets y no abrir acceso entrante desde Internet.

## Rollback y limites

El modo directo queda como rollback temporal. La migracion es aditiva; el rollback operativo consiste en revocar agentes y volver el frontend a `direct`. No eliminar tablas con historial. La cola requiere que la migracion se aplique antes de activar `agent` en QA.
