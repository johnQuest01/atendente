import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createProduct,
  deleteProduct,
  getProductById,
  listProducts,
  updateProduct,
} from '../db/queries/products';
import { persistFile, cleanupTmp } from '../services/storage.service';
import { NotFoundError } from '../utils/errors';
import path from 'node:path';

export const idParamSchema = z.object({ id: z.string().uuid() });

export const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  category: z.string().max(100).optional(),
  price_wholesale: z.coerce.number().nonnegative().optional(),
  min_quantity: z.coerce.number().int().positive().default(1),
  unit: z.string().max(50).optional(),
  image_urls: z.array(z.string().url()).optional(),
  keywords: z.array(z.string()).default([]),
});

export const updateProductSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  price_wholesale: z.coerce.number().nonnegative().nullable().optional(),
  min_quantity: z.coerce.number().int().positive().optional(),
  unit: z.string().max(50).nullable().optional(),
  image_urls: z.array(z.string().url()).optional(),
  keywords: z.array(z.string()).optional(),
  is_available: z.boolean().optional(),
});

export async function getProducts(_req: Request, res: Response): Promise<void> {
  const products = await listProducts(false);
  res.json({ products });
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const product = await getProductById(id);
  if (!product) throw new NotFoundError('Produto');
  res.json({ product });
}

export async function postProduct(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof createProductSchema>;
  const product = await createProduct({
    name: body.name,
    description: body.description ?? null,
    category: body.category ?? null,
    priceWholesale: body.price_wholesale ?? null,
    minQuantity: body.min_quantity,
    unit: body.unit ?? null,
    imageUrls: body.image_urls ?? [],
    keywords: body.keywords,
  });
  res.status(201).json({ product });
}

export async function patchProduct(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const product = await updateProduct(id, req.body as z.infer<typeof updateProductSchema>);
  if (!product) throw new NotFoundError('Produto');
  res.json({ product });
}

export async function removeProduct(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const ok = await deleteProduct(id);
  if (!ok) throw new NotFoundError('Produto');
  res.status(204).send();
}

/** Upload de uma ou mais imagens; retorna as URLs públicas. */
export async function uploadProductImages(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const urls: string[] = [];
  for (const file of files) {
    const filename = `${Date.now()}-${path.basename(file.filename)}`;
    const stored = await persistFile(file.path, 'products', filename).catch(async (err) => {
      await cleanupTmp(file.path);
      throw err;
    });
    urls.push(stored.url);
  }
  res.status(201).json({ urls });
}
