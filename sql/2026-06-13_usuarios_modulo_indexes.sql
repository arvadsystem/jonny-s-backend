-- Optimizaciones no destructivas para el submodulo Usuarios.
-- Enfocado en filtros por estado, joins frecuentes y busquedas por claves comunes.

CREATE INDEX IF NOT EXISTS idx_usuarios_estado
  ON public.usuarios (estado);

CREATE INDEX IF NOT EXISTS idx_usuarios_nombre_usuario
  ON public.usuarios (nombre_usuario);

CREATE INDEX IF NOT EXISTS idx_usuarios_id_empleado
  ON public.usuarios (id_empleado);

CREATE INDEX IF NOT EXISTS idx_usuarios_id_cliente
  ON public.usuarios (id_cliente);

CREATE INDEX IF NOT EXISTS idx_roles_usuarios_id_usuario
  ON public.roles_usuarios (id_usuario);

CREATE INDEX IF NOT EXISTS idx_roles_usuarios_id_rol
  ON public.roles_usuarios (id_rol);

CREATE INDEX IF NOT EXISTS idx_personas_dni
  ON public.personas (dni);

CREATE INDEX IF NOT EXISTS idx_personas_nombre
  ON public.personas (nombre);

CREATE INDEX IF NOT EXISTS idx_personas_apellido
  ON public.personas (apellido);

CREATE INDEX IF NOT EXISTS idx_correos_direccion_correo
  ON public.correos (direccion_correo);

CREATE INDEX IF NOT EXISTS idx_telefonos_telefono
  ON public.telefonos (telefono);
