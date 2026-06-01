import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/services/api';
import type { Product } from '@/types';

export interface ProductInput {
  name: string;
  description?: string;
  category?: string;
  price_wholesale?: number;
  min_quantity: number;
  unit?: string;
  image_urls?: string[];
  keywords: string[];
}

export function useProducts() {
  return useQuery({
    queryKey: ['products'],
    queryFn: async () => {
      const { data } = await api.get<{ products: Product[] }>('/products');
      return data.products;
    },
  });
}

export function useUploadProductImages() {
  return useMutation({
    mutationFn: async (formData: FormData) => {
      const { data } = await api.post<{ urls: string[] }>('/products/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return data.urls;
    },
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProductInput) => {
      const { data } = await api.post<{ product: Product }>('/products', input);
      return data.product;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
      const { data } = await api.patch<{ product: Product }>(`/products/${id}`, patch);
      return data.product;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/products/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['products'] }),
  });
}
