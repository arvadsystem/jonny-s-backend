---
name: jonnys-smartorder-engineering-practices
description: Use when writing, modifying, refactoring, testing, debugging, or reviewing code in Jonny's SmartOrder frontend, backend, or Supabase/PostgreSQL database. Triggers include sales, cash register, orders, payments, kitchen/KDS, inventory, invoicing, split bill, discounts, extras, complements, sauces, public menu, authentication, authorization, RBAC, API contracts, SQL, migrations, security, performance, QA, smoke checks, and work in the jonny-s-smartorder or jonny-s-backend repositories.
---

# Jonny's SmartOrder Engineering Practices

## Purpose

Apply senior engineering practices to Jonny's SmartOrder, a restaurant fast-food management system for Honduras. Make changes that are small, safe, reviewable, maintainable, and consistent with the current architecture.

Prioritize correctness, data integrity, security, maintainability, simplicity, and low production risk. Prefer understanding the existing flow over introducing new patterns.

## Project Map

Frontend repository:

```text
arvadsystem/jonny-s-smartorder
```

Frontend stack and important areas:

```text
React, Vite, JavaScript ES Modules, React Router, Bootstrap, Bootstrap Icons,
Sass, Framer Motion, React Select

src/App.jsx
src/services/api.js
src/services/ventasService.js
src/utils/constants.js
src/routes/
src/context/
src/hooks/
src/components/
src/pages/auth/
src/pages/dashboard/
src/pages/dashboard/ventas/
src/modules/ventas/
src/modules/public-menu/
vite.config.js
```

Backend repository:

```text
arvadsystem/jonny-s-backend
```

Backend stack and important areas:

```text
Node.js, Express, JavaScript ES Modules, pg, Supabase JS dependency,
JWT authentication, cookie session token, CSRF, Helmet, CORS,
Express rate limit, PDF generation utilities, Sharp

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

Database:

```text
PostgreSQL on Supabase
```

Important domains include sales, orders, pending payment, invoicing, cash sessions, cash movements, cash closing, inventory movements, products, ingredients, recipes, combos, public menu, discounts, extras, sauces, customers, users, roles, permissions, audit, loyalty, payroll, and reports.

Important tables often involved:

```text
pedidos
detalle_pedido
detalle_pedido_extras
pedidos_pago_control
facturas
detalle_facturas
detalle_factura_extras
facturas_cobros
cajas
cajas_sesiones
cajas_movimientos
cajas_cierres
productos
insumos
almacenes
movimientos_inventario
recetas
detalle_recetas
combos
detalle_combo
menu
detalle_menu
menu_extras
producto_extra
receta_extra
sucursales
usuarios
roles
permisos
roles_usuarios
roles_permisos
clientes
personas
```

## Operating Rules

Before modifying code:

1. Inspect the current file.
2. Inspect nearby related files.
3. Inspect the related frontend service, backend route, and database table when a change crosses layers.
4. Identify current conventions and reuse existing utilities, services, validators, parsers, request helpers, and error shapes.
5. State the affected files before editing when the work is substantial.
6. Keep the diff small and focused on the requested behavior.
7. Preserve public API contracts unless the user explicitly asks to change them.
8. Avoid unrelated cleanup, broad formatting, framework changes, and mass rewrites.
9. Avoid production data changes and destructive SQL unless explicitly authorized.

Use practical guidance from Clean Code, The Pragmatic Programmer, Refactoring, Working Effectively with Legacy Code, and Google Code Review Practices without quoting them. Convert those principles into local decisions: clear names, small functions, low coupling, behavior preservation, safe incremental refactoring, explicit error handling, maintainability, security, and testability.

## Frontend Rules

Use the existing React + Vite + JavaScript structure. Do not assume TypeScript.

For API calls:

- Prefer existing service methods under `src/services/`.
- Use `src/services/api.js` and `apiFetch` unless an existing pattern justifies a direct fetch, such as a PDF blob download.
- Preserve `credentials: include`, CSRF behavior, request timeout behavior, safe UI error messages, 401 logout behavior, and idempotency key patterns.
- Match backend validation and error contracts; frontend validation never replaces backend validation.

For UI and state:

- Follow existing Bootstrap layouts, cards, tables, modals, alerts, toasts, and responsive conventions.
- Do not introduce new UI libraries without explicit justification.
- Keep components focused and accessible where practical.
- Keep hooks focused on UI state and side effects; use memoization only when useful.
- Handle loading, error, empty, and success states consistently.
- Reject impossible quantities, invalid IDs, invalid dates, negative amounts, and invalid money input where applicable.

## Backend Rules

Use the existing Node.js + Express + JavaScript ES Modules architecture. Do not assume Fastify, Nest, TypeScript, Prisma, Sequelize, or another ORM.

Follow the current structure:

- `app.js` mounts routers and global middleware.
- `routers/` contains route modules.
- Large routers may be gradually modularized.
- `routers/ventas/` contains handlers, services, constants, and utils for sales.
- `services/` contains reusable business/data services.
- `middleware/` contains auth, CSRF, permissions, session, and audit logic.
- `config/db-connection.js` exports the PostgreSQL pool.

Preserve protected middleware order unless the user explicitly asks for a reviewed change:

```text
authRequired
requireActiveSession
requirePasswordChange
touchSessionMiddleware
csrfProtect
globalAuditMiddleware
```

Keep public routes before global auth only when intentionally public and reviewed.

For handlers:

- Parse input clearly.
- Validate required fields.
- Use services for business logic where practical.
- Avoid mixing HTTP transport with long SQL/business logic.
- Return consistent error shapes.
- Log internal details server-side only.
- Avoid raw PostgreSQL messages and stack traces in responses.
- Use existing permission middleware where applicable.

## SQL And Transactions

Always parameterize user input. Do not concatenate user input into SQL. Allow dynamic SQL only from internal constants or whitelists, never direct request values.

Use transactions for multi-table critical writes, especially creating sales, creating orders, registering payments, confirming pending orders, updating inventory, creating invoices, creating cash movements, split bill operations, reversals, and loyalty movements.

Use this transaction shape:

```text
BEGIN
critical operations
COMMIT
ROLLBACK on error
release client
```

For money and inventory:

- Keep money as `numeric` in PostgreSQL.
- Avoid floating-point drift in JavaScript money calculations.
- Use existing money rounding helpers where present.
- Preserve decimal inventory quantities where columns are `numeric`.
- Check current column types before changing logic.

## API Contract Rules

Before changing an endpoint, inspect:

- Frontend service method.
- Frontend normalizer/helper.
- Backend route.
- Backend response shape.
- Database fields involved.
- Existing error codes.
- Permissions.
- CSRF and auth requirements.

Do not silently change endpoint path, HTTP method, field names, error codes, pagination shape, summary shape, auth behavior, CSRF behavior, or response compatibility.

If an API contract must change, explain why, frontend impact, backend impact, database impact, migration or compatibility plan, and manual test steps.

## Database Change Rules

Treat Supabase/PostgreSQL as a critical source of truth.

Never expose service role keys, secrets, `.env` values, raw database credentials, JWT secrets, private keys, or email credentials. Do not assume RLS protects data; inspect RLS before relying on it.

For any database change, provide:

1. Reason.
2. Exact SQL migration.
3. Whether it is destructive.
4. Whether it is reversible.
5. Expected affected tables.
6. Expected affected endpoints.
7. Rollback plan if practical.
8. Verification query.
9. Performance impact.
10. Security/RLS impact.

Do not execute production database changes unless explicitly instructed. Prefer migration files under `sql/` when repository convention exists. Avoid broad `DELETE`, `TRUNCATE`, `DROP`, or risky `ALTER` operations without explicit approval.

## Security Checklist

Check authentication, authorization, RBAC permission, session validity, CSRF for state-changing requests, CORS assumptions, cookie behavior, sensitive data exposure, SQL injection risk, raw error leakage, public endpoint exposure, upload limits, and access to reports, invoices, cash sessions, inventory, and payroll.

## Refactoring Rules

Refactor incrementally and preserve behavior. Read before changing, identify behavior to preserve, find a seam, and extract one responsibility at a time only when it reduces risk or complexity.

For large files such as sales or cash register routers:

- Do not rewrite the entire file.
- Do not change SQL and UI in the same refactor unless necessary.
- Preserve route order.
- Avoid circular dependencies.
- Keep exports and imports simple.
- Avoid renaming public fields.
- Preserve old compatibility redirects when already present.

## Review Checklist

When reviewing or validating a change, check:

- Does it solve the requested problem?
- Does it preserve existing behavior?
- Does it affect sales, cash register, orders, payments, kitchen, inventory, discounts, extras, complements, sauces, split bill, or invoicing?
- Are validations correct?
- Are errors safe and consistent?
- Are SQL queries parameterized?
- Are transactions used where needed?
- Are permissions checked?
- Is CSRF respected?
- Are API contracts preserved?
- Are constraints and indexes considered?
- Is the change readable, focused, and reviewable?
- Are secrets avoided?
- Are migrations safe?
- Are verification commands or manual tests appropriate?

## Verification

Use commands that exist in `package.json`.

Frontend:

```bash
npm run lint
npm run build
```

Optional frontend smoke:

```bash
npm run qa:personas-planillas:smoke
```

Backend:

```bash
node --check app.js
npm run qa:menu-publico
npm run rbac:personas:dry-run
```

For modified backend files:

```bash
node --check path/to/file.js
```

Do not run `npm test` in the backend unless explicitly requested, because the current backend test script intentionally exits with an error.

Run one reasonable verification pass, fix obvious syntax/import errors once, then stop and report. For database migrations, provide verification SQL but do not execute it unless authorized.

## Done Criteria

A task is done when the requested behavior is implemented, existing behavior is preserved, only relevant files changed, API contracts are documented if changed, database changes are provided as migration SQL if needed, secrets are avoided, verification is run or clearly listed, risks are stated, and manual test steps are provided for critical flows.

## Response Templates

For implementation tasks, keep the response compact but include:

```md
## Scope
- Requested change:
- Repositories/files affected:
- Out of scope:

## Existing flow checked
- Frontend:
- Backend:
- Database:

## Changes made
- File:
  - Change:

## Verification
- Command:
- Result:

## Risks
- Risk:
- Mitigation:

## Manual test steps
1.
2.
3.
```

For code review tasks, lead with findings and include:

```md
## Review result
- Status: approve / request changes / needs manual test

## Critical findings
1.

## Important findings
1.

## Minor findings
1.

## Contract impact
- API:
- Database:
- Frontend:

## Security impact
- Auth:
- Permissions:
- Data exposure:

## Verification recommended
- Commands:
- Manual tests:
```

For database tasks, include:

````md
## Database task
- Goal:
- Tables affected:
- Data destructive: yes/no
- Requires backup: yes/no

## Current schema checked
- Tables:
- Columns:
- Constraints:
- Indexes:
- RLS:

## Proposed SQL
```sql
-- migration here
```

## Rollback
```sql
-- rollback here, if practical
```

## Verification SQL
```sql
-- verification query here
```

## Backend/frontend impact
- Backend:
- Frontend:

## Risks
- Integrity:
- Performance:
- Security:
````
