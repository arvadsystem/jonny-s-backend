# AGENTS.md — Jonny's SmartOrder Backend

## Repository context

Repository:

```text
arvadsystem/jonny-s-backend
```

This is the backend for Jonny's SmartOrder.

Detected stack:

- Node.js.
- Express.
- JavaScript ES Modules.
- PostgreSQL through `pg`.
- Supabase JS dependency.
- JWT.
- Cookie parser.
- CORS.
- Helmet.
- CSRF middleware.
- Session validation.
- Global audit middleware.
- PDF utilities.
- Sharp.

Do not assume:

- Fastify.
- Nest.
- TypeScript.
- Prisma.
- Sequelize.
- Another ORM.

## Real scripts

Use only scripts that exist in `package.json`:

```bash
npm run start
npm run dev
npm run qa:menu-publico
npm run rbac:personas:dry-run
npm run rbac:personas:sync
```

Current `npm test` intentionally exits with error.

Do not use it unless the user explicitly asks.

## Important structure

Known important files and folders:

```text
app.js
config/db-connection.js
middleware/
routers/
routers/ventas.js
routers/ventas/
routers/cajas.js
services/
utils/
jobs/
scripts/
sql/
```

## Architecture rules

- Keep public routes before global auth only when intentionally public.
- Keep protected routes behind the existing auth/session/password/CSRF/audit chain.
- Do not alter middleware order without explicit reason.
- Use `pg.Pool` from `config/db-connection.js`.
- Use parameterized SQL.
- Avoid raw SQL string interpolation from request input.
- Use existing permission middleware.
- Keep route handlers thin when practical.

## Middleware rules

Protected flow must respect:

```text
authRequired
requireActiveSession
requirePasswordChange
touchSessionMiddleware
csrfProtect
globalAuditMiddleware
```

Do not remove or bypass these for protected business operations.

## Sales/cash critical rules

Before touching sales, cash, orders, payments, inventory or invoicing, inspect relevant files:

```text
routers/ventas.js
routers/ventas/constants.js
routers/ventas/handlers/
routers/ventas/services/
routers/ventas/utils/
routers/cajas.js
services/facturacion*
services/fidelizacion*
services/inventario*
sql/
```

Do not break:

- Direct sale.
- Pending order.
- Registering payment.
- Payment validation.
- Kitchen visibility.
- Inventory discount.
- Extras.
- Complements.
- Sauces.
- Discounts.
- Split bill.
- Facturas.
- Facturas cobros.
- Cash sessions.
- Cash closing.
- Reversals.
- Loyalty accumulation.

## Database rules

- Use transactions for multi-table writes.
- Do not execute destructive SQL without explicit approval.
- Put migration proposals in `sql/` when needed.
- Check current schema before assuming columns.
- Do not touch backup tables unless instructed.
- Preserve existing data.
- Review indexes for frequent filters and joins.
- Review RLS/security advisor concerns before exposing data.
- Use `numeric` for money and decimal quantities.
- Avoid JavaScript floating-point drift.
- Use existing money rounding helpers where present.

## Error handling rules

- Return safe public messages.
- Include stable `code` when existing flow uses codes.
- Log internal errors server-side.
- Do not send raw PostgreSQL errors to frontend.
- Do not leak stack traces.
- Preserve existing response shapes.

## Security rules

- Do not expose `.env`.
- Do not print secrets.
- Do not expose service role keys.
- Do not weaken CORS.
- Do not weaken cookies.
- Do not bypass CSRF.
- Do not skip permission checks.
- Validate user scope by sucursal/role where existing utilities support it.
- Do not trust frontend values for price, permissions, totals or inventory effects.

## Refactor rules

- Refactor incrementally.
- Avoid broad rewrites of `ventas.js` or `cajas.js`.
- Extract one responsibility at a time.
- Preserve route order.
- Preserve endpoint path and method.
- Preserve error contract.
- Keep imports simple.
- Avoid circular dependencies.
- Avoid adding abstractions without immediate use.

## Verification

Preferred checks:

```bash
node --check app.js
node --check routers/ventas.js
node --check routers/cajas.js
npm run qa:menu-publico
npm run rbac:personas:dry-run
```

Only run checks relevant to changed files.

Do not run endless tests.

## Do not do

- Do not convert to TypeScript.
- Do not install new frameworks.
- Do not modify production data.
- Do not execute migrations unless explicitly authorized.
- Do not expose secrets.
- Do not change API contracts silently.
- Do not remove idempotency safeguards.
- Do not remove inventory duplicate-discount protections.
- Do not change cash session behavior without full impact review.
- Do not change fiscal invoice logic casually.
- Do not touch unrelated modules.