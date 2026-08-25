-- Create the menu_items table
CREATE TABLE IF NOT EXISTS public.menu_items (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text,
  diet text,
  tag text,
  description text,
  image text,
  "portionType" text,
  price numeric,
  "pricesJSON" jsonb,
  created_at timestamptz DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read the menu (public menu)
CREATE POLICY "Anyone can view menu items"
  ON public.menu_items
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Only authenticated users (admin) can insert
CREATE POLICY "Authenticated users can insert menu items"
  ON public.menu_items
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Only authenticated users (admin) can update
CREATE POLICY "Authenticated users can update menu items"
  ON public.menu_items
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Only authenticated users (admin) can delete
CREATE POLICY "Authenticated users can delete menu items"
  ON public.menu_items
  FOR DELETE
  TO authenticated
  USING (true);
