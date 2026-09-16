'use client';

import { useState } from 'react';
import { useCart } from '@/lib/cart-store';
import { ShoppingCart, Check, AlertCircle } from 'lucide-react';

interface AddToCartButtonProps {
  sku: string;
  description: string;
  qty: number;
  unitPrice: number;
  onAdd?: () => void;
}

export function AddToCartButton({
  sku,
  description,
  qty,
  unitPrice,
  onAdd
}: AddToCartButtonProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [feedback, setFeedback] = useState<'idle' | 'success' | 'error'>('idle');
  const addItem = useCart(state => state.addItem);
  
  const handleAddToCart = async () => {
    if (qty <= 0) {
      setFeedback('error');
      setTimeout(() => setFeedback('idle'), 2000);
      return;
    }
    
    setIsAdding(true);
    try {
      // Add to store
      addItem({
        sku,
        description,
        qty,
        unitPrice
      });
      
      setFeedback('success');
      onAdd?.();
      
      // Reset feedback after 2 seconds
      setTimeout(() => setFeedback('idle'), 2000);
    } catch (err) {
      setFeedback('error');
      setTimeout(() => setFeedback('idle'), 2000);
    } finally {
      setIsAdding(false);
    }
  };
  
  return (
    <button
      onClick={handleAddToCart}
      disabled={isAdding || qty <= 0}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
        feedback === 'success'
          ? 'bg-emerald-100 text-emerald-700 border border-emerald-300'
          : feedback === 'error'
          ? 'bg-red-100 text-red-700 border border-red-300'
          : 'bg-wave text-white hover:bg-deep disabled:opacity-50'
      }`}
    >
      {feedback === 'success' ? (
        <>
          <Check size={18} />
          Added!
        </>
      ) : feedback === 'error' ? (
        <>
          <AlertCircle size={18} />
          Invalid qty
        </>
      ) : (
        <>
          <ShoppingCart size={18} />
          Add to Cart
        </>
      )}
    </button>
  );
}
