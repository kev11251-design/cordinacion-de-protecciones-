-- Script de configuración para Supabase
-- Ejecute este script en el editor SQL de su consola de Supabase (SQL Editor)

-- 1. Crear la tabla para almacenar las coordinaciones/simulaciones
CREATE TABLE IF NOT EXISTS public.coordinaciones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    name text NOT NULL,
    description text,
    state jsonb NOT NULL
);

-- 2. Habilitar seguridad de nivel de fila (Row Level Security - RLS)
ALTER TABLE public.coordinaciones ENABLE ROW LEVEL SECURITY;

-- 3. Crear políticas para permitir acceso público anónimo (Select, Insert, Update, Delete)
-- NOTA: Dado que esta es una aplicación cliente con clave pública 'anon', se permite acceso completo.
-- En entornos de producción real, se recomienda restringir esto a usuarios autenticados.

CREATE POLICY "Permitir lectura publica" ON public.coordinaciones 
    FOR SELECT USING (true);

CREATE POLICY "Permitir insercion publica" ON public.coordinaciones 
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Permitir modificacion publica" ON public.coordinaciones 
    FOR UPDATE USING (true);

CREATE POLICY "Permitir eliminacion publica" ON public.coordinaciones 
    FOR DELETE USING (true);
