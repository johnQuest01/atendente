import { useState } from 'react';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input, TextArea } from '@/components/ui/Input';
import { FileUpload } from '@/components/ui/FileUpload';
import { ProductCard } from '@/components/features/ProductCard';
import { Spinner, ErrorState, EmptyState } from '@/components/ui/States';
import { ProductIcon, PlusIcon } from '@/components/ui/Icons';
import {
  useCreateProduct,
  useDeleteProduct,
  useProducts,
  useUploadProductImages,
} from '@/hooks/useProducts';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import type { Product } from '@/types';

export default function Products() {
  const { data, isLoading, isError, refetch } = useProducts();
  const deleteProduct = useDeleteProduct();
  const [open, setOpen] = useState(false);

  async function handleDelete(product: Product) {
    if (!confirm(`Excluir "${product.name}"?`)) return;
    try {
      await deleteProduct.mutateAsync(product.id);
      toast('Produto excluído.', 'success');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <>
      <PageHeader
        title="Produtos"
        subtitle="Catálogo de atacado"
        action={
          <Button size="sm" onClick={() => setOpen(true)}>
            <PlusIcon width={18} height={18} /> Novo
          </Button>
        }
      />

      {isLoading && <Spinner label="Carregando produtos..." />}
      {isError && <ErrorState message="Erro ao carregar produtos." onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <EmptyState
          icon={<ProductIcon width={40} height={40} />}
          title="Nenhum produto cadastrado"
          description="Adicione produtos com fotos e preço de atacado."
          action={<Button onClick={() => setOpen(true)}>Cadastrar produto</Button>}
        />
      )}

      {data && data.length > 0 && (
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
          {data.map((p) => (
            <ProductCard key={p.id} product={p} onDelete={handleDelete} />
          ))}
        </div>
      )}

      <CreateProductModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function CreateProductModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateProduct();
  const uploadImages = useUploadProductImages();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [price, setPrice] = useState('');
  const [minQty, setMinQty] = useState('1');
  const [unit, setUnit] = useState('');
  const [keywords, setKeywords] = useState('');
  const [imageUrls, setImageUrls] = useState<string[]>([]);

  function reset() {
    setName('');
    setDescription('');
    setCategory('');
    setPrice('');
    setMinQty('1');
    setUnit('');
    setKeywords('');
    setImageUrls([]);
  }

  async function handleImages(files: File[]) {
    const form = new FormData();
    files.forEach((f) => form.append('images', f));
    try {
      const urls = await uploadImages.mutateAsync(form);
      setImageUrls((prev) => [...prev, ...urls]);
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao enviar imagens.'), 'error');
    }
  }

  async function handleSubmit() {
    if (!name.trim()) return toast('Informe o nome do produto.', 'error');
    try {
      await create.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        category: category.trim() || undefined,
        price_wholesale: price ? Number(price) : undefined,
        min_quantity: Number(minQty) || 1,
        unit: unit.trim() || undefined,
        image_urls: imageUrls,
        keywords: keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : [],
      });
      toast('Produto cadastrado!', 'success');
      reset();
      onClose();
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Novo produto"
      footer={
        <Button fullWidth loading={create.isPending} onClick={handleSubmit}>
          Salvar produto
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <FileUpload accept="image/*" multiple onFiles={handleImages} />
        {uploadImages.isPending && <p className="text-center text-xs text-text-secondary">Enviando imagens...</p>}
        {imageUrls.length > 0 && (
          <div className="flex gap-2 overflow-x-auto">
            {imageUrls.map((url) => (
              <img key={url} src={url} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
            ))}
          </div>
        )}

        <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
        <TextArea label="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Categoria" value={category} onChange={(e) => setCategory(e.target.value)} />
          <Input label="Preço atacado" type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" />
          <Input label="Qtd. mínima" type="number" value={minQty} onChange={(e) => setMinQty(e.target.value)} />
          <Input label="Unidade" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="caixa com 12" />
        </div>
        <Input label="Palavras-chave (vírgula)" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
      </div>
    </Modal>
  );
}
