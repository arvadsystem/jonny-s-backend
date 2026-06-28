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

  it('auto-auxiliar SUPER_ADMIN no usa bloqueo global ni escribe autorizaciones', () => {
    const start = source.indexOf("router.post('/ventas/cajas/sesiones/:id/auto-auxiliar'");
    assert.ok(start > 0, 'debe existir endpoint auto-auxiliar');
    const end = source.indexOf("router.patch('/ventas/cajas/sesiones/:id/participantes/:id_participante/inactivar'", start + 1);
    const endpointSource = source.slice(start, end > start ? end : source.length);

    assert.match(endpointSource, /requestIsSuperAdminReal\(client,\s*req\)/, 'debe validar SUPER_ADMIN real en base de datos');
    assert.match(endpointSource, /requestHasAnyPermission\(req,\s*'VENTAS_CREAR',\s*client\)/, 'debe validar permiso real de venta');
    assert.match(endpointSource, /session\.permite_auxiliares/, 'debe validar que la caja permita auxiliares');
    assert.doesNotMatch(endpointSource, /assertUsersNotInAnotherOpenSession/, 'SUPER_ADMIN no debe ejecutar bloqueo global');
    assert.doesNotMatch(endpointSource, /cajas_usuarios_autorizados/, 'auto-auxiliar no debe crear ni modificar autorizaciones');
    assert.match(endpointSource, /ON CONFLICT \(id_sesion_caja,\s*id_usuario\) WHERE activo IS TRUE[\s\S]*DO NOTHING/, 'debe ser idempotente por sesion+usuario');
    assert.match(endpointSource, /getCatalogId\(client,\s*'PARTICIPATION_ROLES',\s*'AUXILIAR'\)/, 'debe insertar siempre rol AUXILIAR');
    assert.doesNotMatch(endpointSource, /'RESPONSABLE'/, 'auto-auxiliar no debe convertir al usuario en responsable');
  });
});
