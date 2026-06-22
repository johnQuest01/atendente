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

export async function listProducts(tenantId: string, availableOnly = false): Promise<Product[]> {
  const availableFilter = availableOnly ? 'AND is_available = true' : '';
  const { rows } = await query<Product>(
    `SELECT * FROM products
      WHERE tenant_id = $1 ${availableFilter}
      ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows;
}

export async function getProductById(tenantId: string, id: string): Promise<Product | null> {
  return queryOne<Product>('SELECT * FROM products WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
}

export async function createProduct(tenantId: string, input: CreateProductInput): Promise<Product> {
  const { rows } = await query<Product>(
    `INSERT INTO products
       (tenant_id, name, description, category, price_wholesale, min_quantity, unit, image_urls, keywords)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      tenantId,
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
  tenantId: string,
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
       name = COALESCE($3, name),
       description = COALESCE($4, description),
       category = COALESCE($5, category),
       price_wholesale = COALESCE($6, price_wholesale),
       min_quantity = COALESCE($7, min_quantity),
       unit = COALESCE($8, unit),
       image_urls = COALESCE($9, image_urls),
       keywords = COALESCE($10, keywords),
       is_available = COALESCE($11, is_available)
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [
      id,
      tenantId,
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

export async function deleteProduct(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM products WHERE id = $1 AND tenant_id = $2', [
    id,
    tenantId,
  ]);
  return (rowCount ?? 0) > 0;
}
