import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/utils/cn';

const baseField =
  'w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-[15px] text-text-primary placeholder:text-text-secondary/70 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, className, id, ...rest },
  ref,
) {
  return (
    <label className="block">
      {label && <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>}
      <input ref={ref} id={id} className={cn(baseField, className)} {...rest} />
      {hint && <span className="mt-1 block text-xs text-text-secondary">{hint}</span>}
    </label>
  );
});

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, className, ...rest },
  ref,
) {
  return (
    <label className="block">
      {label && <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>}
      <textarea ref={ref} className={cn(baseField, 'min-h-24 resize-y', className)} {...rest} />
      {hint && <span className="mt-1 block text-xs text-text-secondary">{hint}</span>}
    </label>
  );
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  children: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ label, className, children, ...rest }, ref) {
    return (
      <label className="block">
        {label && (
          <span className="mb-1.5 block text-sm font-medium text-text-primary">{label}</span>
        )}
        <select ref={ref} className={cn(baseField, 'appearance-none', className)} {...rest}>
          {children}
        </select>
      </label>
    );
  },
);
