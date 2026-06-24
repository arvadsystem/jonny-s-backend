import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canBypassCajaSucursalForAuxiliary } from '../../services/cajaAssignmentRulesService.js';

describe('canBypassCajaSucursalForAuxiliary', () => {
  it('permite solamente actor SUPER_ADMIN real asignando objetivo SUPER_ADMIN como auxiliar exclusivo', () => {
    assert.equal(canBypassCajaSucursalForAuxiliary({
      actorIsSuperAdmin: true,
      targetRoleCodes: ['SUPER_ADMIN'],
      puedeResponsable: false,
      puedeAuxiliar: true
    }), true);
  });

  it('permite objetivo con multiples roles cuando incluye SUPER_ADMIN exacto', () => {
    assert.equal(canBypassCajaSucursalForAuxiliary({
      actorIsSuperAdmin: true,
      targetRoleCodes: ['SUPER_ADMIN', 'ADMIN'],
      puedeResponsable: false,
      puedeAuxiliar: true
    }), true);
  });

  it('rechaza ADMIN y ADMINISTRADOR sin SUPER_ADMIN exacto', () => {
    assert.equal(canBypassCajaSucursalForAuxiliary({
      actorIsSuperAdmin: true,
      targetRoleCodes: ['ADMIN'],
      puedeResponsable: false,
      puedeAuxiliar: true
    }), false);
    assert.equal(canBypassCajaSucursalForAuxiliary({
      actorIsSuperAdmin: true,
      targetRoleCodes: ['ADMINISTRADOR'],
      puedeResponsable: false,
      puedeAuxiliar: true
    }), false);
    assert.equal(canBypassCajaSucursalForAuxiliary({
      actorIsSuperAdmin: true,
      targetRoleCodes: ['ADMIN', 'ADMINISTRADOR'],
      puedeResponsable: false,
      puedeAuxiliar: true
    }), false);
  });

  it('rechaza actor no SUPER_ADMIN, responsable y asignacion mixta', () => {
    assert.equal(canBypassCajaSucursalForAuxiliary({
      actorIsSuperAdmin: false,
      targetRoleCodes: ['SUPER_ADMIN'],
      puedeResponsable: false,
      puedeAuxiliar: true
    }), false);
    assert.equal(canBypassCajaSucursalForAuxiliary({
      actorIsSuperAdmin: true,
      targetRoleCodes: ['SUPER_ADMIN'],
      puedeResponsable: true,
      puedeAuxiliar: false
    }), false);
    assert.equal(canBypassCajaSucursalForAuxiliary({
      actorIsSuperAdmin: true,
      targetRoleCodes: ['SUPER_ADMIN'],
      puedeResponsable: true,
      puedeAuxiliar: true
    }), false);
  });
});
