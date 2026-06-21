QZ Tray certificates

This folder is reserved for the QZ Tray public certificate and private key used by the backend signing endpoints.

Expected local files:

- `qz-public-cert.pem`
- `qz-private-key.pem`

Important rules:

- Never commit real private keys.
- The private key must stay only on the backend/server.
- The public certificate can be exposed by the backend endpoint.
- Example placeholder files can be committed with the `.example.pem` suffix.

Development example with OpenSSL:

```bash
openssl req -x509 -newkey rsa:2048 \
  -keyout qz-private-key.pem \
  -out qz-public-cert.pem \
  -days 3650 \
  -nodes \
  -subj "/CN=qa.jonnyshn.com/O=Jonnys SmartOrder/C=HN"
```

Recommended environment variables:

```env
QZ_CERTIFICATE_PATH=./config/qz/qz-public-cert.pem
QZ_PRIVATE_KEY_PATH=./config/qz/qz-private-key.pem
QZ_SIGNATURE_ALGORITHM=SHA512
```
