import type { Product } from '@/types';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ImageIcon, TrashIcon } from '@/components/ui/Icons';
import { formatBRL } from '@/utils/formatters';

interface ProductCardProps {
  product: Product;
  onDelete?: (product: Product) => void;
  onSend?: (product: Product) => void;
}

export function ProductCard({ product, onDelete, onSend }: ProductCardProps) {
  const cover = product.image_urls[0];

  return (
    <Card padded={false} className="flex flex-col overflow-hidden">
      <div className="relative aspect-square w-full bg-bg">
        {cover ? (
          <img src={cover} alt={product.name} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-border">
            <ImageIcon width={40} height={40} />
          </div>
        )}
        {!product.is_available && (
          <span className="absolute left-2 top-2">
            <Badge tone="danger">indisponível</Badge>
          </span>
        )}
        {onDelete && (
          <button
            onClick={() => onDelete(product)}
            className="tap-scale absolute right-2 top-2 rounded-full bg-surface/90 p-1.5 text-danger shadow"
            aria-label="Excluir produto"
          >
            <TrashIcon width={16} height={16} />
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm font-semibold text-text-primary">{product.name}</h3>
        <p className="text-lg font-bold text-primary">{formatBRL(product.price_wholesale)}</p>
        <p className="text-xs text-text-secondary">
          Mín. {product.min_quantity}
          {product.unit ? ` · ${product.unit}` : ''}
        </p>
        {onSend && (
          <button
            onClick={() => onSend(product)}
            className="tap-scale mt-2 rounded-lg bg-primary-light py-1.5 text-xs font-semibold text-primary"
          >
            Enviar
          </button>
        )}
      </div>
    </Card>
  );
}
