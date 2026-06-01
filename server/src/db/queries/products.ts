import { query, queryOne } from '../index';
import type { Product } from '../../types';

export interface CreateProductInput {
  name: string;
  description?: string | null;
  category?: string | null;
  priceWholesale?: number | null;
  minQuantity?: number;
  unit?: string | null;
  imageUrls?: string[];
  keywords?: string[];
}

export async function listProducts(availableOnly = false): Promise<Product[]> {
  const where = availableOnly ? 'WHERE is_available = true' : '';
  const { rows } = await query<Product>(
    `SELECT * FROM products ${where} ORDER BY created_at DESC`,
  );
  return rows;
}

export async function getProductById(id: string): Promise<Product | null> {
  return queryOne<Product>('SELECT * FROM products WHERE id = $1', [id]);
}

export async function createProduct(input: CreateProductInput): Promise<Product> {
  const { rows } = await query<Product>(
    `INSERT INTO products
       (name, description, category, price_wholesale, min_quantity, unit, image_urls, keywords)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.name,
      input.description ?? null,
      input.category ?? null,
      input.priceWholesale ?? null,
      input.minQuantity ?? 1,
      input.unit ?? null,
      input.imageUrls ?? [],
      input.keywords ?? [],
    ],
  );
  return rows[0];
}

export async function updateProduct(
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    category: string | null;
    price_wholesale: number | null;
    min_quantity: number;
    unit: string | null;
    image_urls: string[];
    keywords: string[];
    is_available: boolean;
  }>,
): Promise<Product | null> {
  const { rows } = await query<Product>(
    `UPDATE products SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       category = COALESCE($4, category),
       price_wholesale = COALESCE($5, price_wholesale),
       min_quantity = COALESCE($6, min_quantity),
       unit = COALESCE($7, unit),
       image_urls = COALESCE($8, image_urls),
       keywords = COALESCE($9, keywords),
       is_available = COALESCE($10, is_available)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      patch.name ?? null,
      patch.description ?? null,
      patch.category ?? null,
      patch.price_wholesale ?? null,
      patch.min_quantity ?? null,
      patch.unit ?? null,
      patch.image_urls ?? null,
      patch.keywords ?? null,
      patch.is_available ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteProduct(id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM products WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
