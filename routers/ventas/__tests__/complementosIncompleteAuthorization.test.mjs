import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveComplementosIncompleteAuthorization,
  VENTAS_COMPLEMENTOS_INCOMPLETOS_AUTORIZAR_PERMISSION
} from '../services/complementosAuthorizationService.js';

describe('autorizacion de complementos incompletos', () => {
  const incompleteSelection = { selectedCount: 2, minimo: 3, maximo: 4, nombreItem: 'Alitas' };

  it('rechaza solicitud del cliente cuando el usuario no tiene permiso', () => {
    const result = resolveComplementosIncompleteAuthorization({
      ...incompleteSelection,
      requestedOverride: true,
      serverAuthorized: false
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.code, 'VENTAS_COMPLEMENTOS_INCOMPLETOS_NO_AUTORIZADO');
  });

  it('autoriza solicitud cuando el permiso proviene del servidor y deja trazabilidad', () => {
    const result = resolveComplementosIncompleteAuthorization({
      ...incompleteSelection,
      requestedOverride: true,
      serverAuthorized: true,
      authorizedByUserId: 27
    });
    assert.equal(result.ok, true);
    assert.equal(result.authorization.complementos_incompletos_autorizados, true);
    assert.equal(result.authorization.complementos_incompletos_autorizado_por, 27);
    assert.equal(result.authorization.complementos_incompletos_permiso, VENTAS_COMPLEMENTOS_INCOMPLETOS_AUTORIZAR_PERMISSION);
  });

  it('acepta seleccion completa sin requerir el permiso de excepcion', () => {
    const result = resolveComplementosIncompleteAuthorization({
      selectedCount: 3,
      minimo: 3,
      maximo: 4,
      requestedOverride: false,
      serverAuthorized: false
    });
    assert.equal(result.ok, true);
    assert.equal(result.authorized, undefined);
  });

  it('conserva el rechazo de exceso aunque exista solicitud y permiso', () => {
    const result = resolveComplementosIncompleteAuthorization({
      selectedCount: 5,
      minimo: 3,
      maximo: 4,
      requestedOverride: true,
      serverAuthorized: true
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'VENTAS_COMPLEMENTOS_EXCEDIDOS');
  });
});
