-- ========================================================
-- CONFIGURACIÓN DE SEGURIDAD (RLS) PARA BUCKET PRIVADO
-- Proyecto: Jonny's SmartOrder
-- Bucket: 'admin-docs' (Documentos Administrativos)
-- ========================================================

-- 1. Asegurar que RLS esté habilitado en la tabla de objetos de storage
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 2. Eliminar políticas previas que puedan causar conflictos (opcional/limpieza)
-- DROP POLICY IF EXISTS "Permitir lectura autenticada en admin-docs" ON storage.objects;
-- DROP POLICY IF EXISTS "Bloquear acceso publico a admin-docs" ON storage.objects;

-- 3. POLÍTICA: Permitir SELECT (lectura) solo a usuarios AUTHENTICATED
-- Nota: Esto permite que las URLs firmadas funcionen correctamente cuando son generadas 
-- por el servidor y accedidas por un cliente con sesión activa.
CREATE POLICY "Permitir lectura autenticada en admin-docs"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'admin-docs');

-- 4. POLÍTICA: Bloquear todo acceso a usuarios ANON (Anónimos)
-- Al no existir una política que permita SELECT a 'anon', el acceso es denegado por defecto.
-- No obstante, podemos ser explícitos si se desea:
-- CREATE POLICY "Denegar anon en admin-docs" ON storage.objects FOR ALL TO anon USING (bucket_id = 'admin-docs') WITH CHECK (false);

-- NOTA IMPORTANTE:
-- El backend utiliza la llave 'service_role', por lo que estas políticas NO afectan
-- las operaciones de INSERT/UPDATE realizadas desde el servidor (bypass RLS).
-- Esto garantiza que el backend siempre pueda subir archivos sin depender de la sesión del usuario.
