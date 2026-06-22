import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createProduct,
  deleteProduct,
  getProductById,
  listProducts,
  updateProduct,
} from '../db/queries/products';
import fs from 'node:fs/promises';
import { cleanupTmp } from '../services/storage.service';
import { insertMediaFile } from '../db/queries/media_files';
import { env } from '../config/env';
import { signMediaToken } from '../utils/media-token';
import { AppError, NotFoundError } from '../utils/errors';

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

export async function getProducts(req: Request, res: Response): Promise<void> {
  const products = await listProducts(req.user!.tenant_id, false);
  res.json({ products });
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const product = await getProductById(req.user!.tenant_id, id);
  if (!product) throw new NotFoundError('Produto');
  res.json({ product });
}

export async function postProduct(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof createProductSchema>;
  const product = await createProduct(req.user!.tenant_id, {
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
  const product = await updateProduct(req.user!.tenant_id, id, req.body as z.infer<typeof updateProductSchema>);
  if (!product) throw new NotFoundError('Produto');
  res.json({ product });
}

export async function removeProduct(req: Request, res: Response): Promise<void> {
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const ok = await deleteProduct(req.user!.tenant_id, id);
  if (!ok) throw new NotFoundError('Produto');
  res.status(204).send();
}

/** Upload de uma ou mais imagens; guarda no banco e retorna URLs estáveis /media. */
export async function uploadProductImages(req: Request, res: Response): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw new AppError('Nenhuma imagem enviada.', 422, 'NO_FILE');

  const tenantId = req.user!.tenant_id;
  const urls: string[] = [];
  try {
    for (const file of files) {
      const data = await fs.readFile(file.path);
      const id = await insertMediaFile(tenantId, {
        kind: 'image',
        mime: file.mimetype || 'image/jpeg',
        data,
        sizeKb: Math.round(data.length / 1024),
      });
      // URL pública estável servida pelo banco (acessível pela Z-API e sobrevive a deploys).
      // Token assinado amarra o arquivo à empresa (BUG 2 — sem acesso cruzado).
      const token = signMediaToken(tenantId, id);
      urls.push(`${env.PUBLIC_BASE_URL}/media/files/${id}?t=${token}`);
    }
  } finally {
    for (const file of files) await cleanupTmp(file.path);
  }

  res.status(201).json({ urls });
}
