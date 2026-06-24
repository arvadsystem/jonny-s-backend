import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve('routers/cajas.js'), 'utf8');

describe('caja assignment route rules', () => {
  it('no bloquea genericamente que ADMIN asigne ADMIN local como auxiliar', () => {
    assert.doesNotMatch(source, /Solo super_admin puede asignar usuarios administradores como auxiliares/);
    assert.doesNotMatch(source, /VENTAS_CAJAS_ASSIGN_ROLE_FORBIDDEN/);
  });

  it('exime solo PATCH estado false puro de la validacion de scope del usuario asignado', () => {
    assert.match(source, /const isPureDeactivation =/);
    assert.match(source, /!hasIdUsuario/);
    assert.match(source, /!hasPuedeResponsable/);
    assert.match(source, /!hasPuedeAuxiliar/);
    assert.match(source, /if \(!isPureDeactivation\) \{/);
    assert.match(source, /VENTAS_CAJAS_USER_SCOPE_MISMATCH/);
  });
});
