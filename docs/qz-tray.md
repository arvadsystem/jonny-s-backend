# QZ Tray - Jonny's SmartOrder

## Goal

QZ Tray must print factura and comanda without blocking the critical sales flow. A sale can succeed even if QZ Tray fails.

## Current architecture

- Frontend requests:
  - `GET /ventas/qz/certificate`
  - `POST /ventas/qz/sign`
- Backend returns the public certificate and signs requests with the private key.
- Frontend configures:
  - `qz.security.setCertificatePromise(...)`
  - `qz.security.setSignaturePromise(...)`
- If QZ fails, the app falls back to manual browser printing and the sale stays created.

## Required backend env vars

```env
QZ_CERTIFICATE_PATH=./config/qz/qz-public-cert.pem
QZ_PRIVATE_KEY_PATH=./config/qz/qz-private-key.pem
QZ_SIGNATURE_ALGORITHM=SHA512
```

Optional alternative names already supported by the backend service:

```env
QZ_TRAY_CERTIFICATE_PATH=./config/qz/qz-public-cert.pem
QZ_TRAY_PRIVATE_KEY_PATH=./config/qz/qz-private-key.pem
QZ_CERTIFICATE_TEXT=
QZ_TRAY_CERTIFICATE_TEXT=
QZ_TRAY_PRIVATE_KEY_PEM=
```

## Required frontend env vars

```env
VITE_QZ_TRAY_SCRIPT_URL=
VITE_QZ_SIGNATURE_ALGORITHM=SHA512
```

`VITE_QZ_TRAY_SCRIPT_URL` is optional if the bundled local or CDN fallback is enough.

## Secure file structure

Suggested backend folder:

```text
config/qz/
  README.md
  qz-public-cert.example.pem
  qz-private-key.example.pem
  qz-public-cert.pem
  qz-private-key.pem
```

Rules:

- `qz-public-cert.pem` can be served by the backend endpoint.
- `qz-private-key.pem` must never leave the backend/server.
- Do not commit real `.pem` files.

## Development certificate generation

```bash
openssl req -x509 -newkey rsa:2048 \
  -keyout qz-private-key.pem \
  -out qz-public-cert.pem \
  -days 3650 \
  -nodes \
  -subj "/CN=qa.jonnyshn.com/O=Jonnys SmartOrder/C=HN"
```

If you are testing on `qa.jonnyshn.com`, use that host in the certificate CN/SAN strategy.

## Backend endpoints

### `GET /ventas/qz/certificate`

- Requires authenticated access with `VENTAS_IMPRIMIR`.
- Returns the public certificate text.
- Must never return the private key.

### `POST /ventas/qz/sign`

Request:

```json
{
  "request": "text-to-sign"
}
```

Response:

```json
{
  "ok": true,
  "signature": "base64-signature"
}
```

- Requires authenticated access with `VENTAS_IMPRIMIR`.
- Uses backend-only private key.

## Frontend behavior

The QZ service:

- loads the QZ library
- fetches the certificate from backend
- registers secure signature callback
- connects to QZ only after security is configured

If the certificate cannot be fetched, the service now throws `QZ_CERTIFICATE_ERROR` instead of attempting an anonymous connection.

If the signature cannot be generated, the service throws `QZ_SIGNATURE_ERROR`.

This prevents the browser app from reaching QZ as an untrusted anonymous request when signing is missing.

## Printing flow

Correct flow:

1. Sale is created in backend.
2. Backend returns success.
3. Frontend tries factura printing.
4. If QZ fails, frontend warns and opens manual print fallback.
5. Frontend optionally asks whether to print the comanda.
6. Comanda failure never cancels the sale.

## Printer configuration

Logical printers used by the app:

- `FACTURA`
- `COCINA`

Configured runtime fields:

- `nombre_impresora_sistema`
- `modo_impresion`
- `ancho_mm`
- `activa`

Do not hardcode physical printer names in code.

## Manual QA checklist

1. QZ active + valid certificate:
   - no anonymous/untrusted warning
   - direct print works
2. Missing certificate:
   - sale succeeds
   - print shows controlled warning/fallback
3. Missing private key:
   - sale succeeds
   - print shows controlled warning/fallback
4. Printer not found:
   - sale succeeds
   - manual fallback remains available
5. Factura reprint:
   - print window auto-closes after print
6. Comanda print:
   - print window auto-closes after print

## Troubleshooting

### "Untrusted website" or "Invalid Certificate"

- Verify backend can read `QZ_CERTIFICATE_PATH`.
- Verify backend can read `QZ_PRIVATE_KEY_PATH`.
- Verify the hostname being used by the browser matches the certificate used for QZ.
- Re-import/trust the certificate in QZ Tray if needed.

### "Printer not found"

- Confirm the exact OS printer name.
- Update the runtime printer configuration, not the source code.

### Sale succeeded but print failed

This is expected fallback-safe behavior. Reprint the factura or comanda manually without recreating the sale.
