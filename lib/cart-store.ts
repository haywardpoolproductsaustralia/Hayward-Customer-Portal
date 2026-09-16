import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CartItem {
  sku: string;
  description: string;
  qty: number;
  unitPrice: number;  // Will be recalculated server-side
}

interface CartState {
  items: CartItem[];
  requiredDate: Date | null;
  deliveryAddress: string | null;
  poRef: string | null;
  notes: string | null;
  
  // Actions
  addItem: (item: CartItem) => void;
  removeItem: (sku: string) => void;
  updateQty: (sku: string, qty: number) => void;
  clearCart: () => void;
  setRequiredDate: (date: Date) => void;
  setDeliveryAddress: (address: string) => void;
  setPoRef: (ref: string) => void;
  setNotes: (notes: string) => void;
  getTotal: () => number;
  getLineCount: () => number;
  isCartReady: () => boolean;
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      requiredDate: null,
      deliveryAddress: null,
      poRef: null,
      notes: null,
      
      addItem: (item: CartItem) =>
        set(state => {
          const existing = state.items.find(i => i.sku === item.sku);
          if (existing) {
            return {
              items: state.items.map(i =>
                i.sku === item.sku ? { ...i, qty: i.qty + item.qty } : i
              )
            };
          }
          return { items: [...state.items, item] };
        }),
      
      removeItem: (sku: string) =>
        set(state => ({
          items: state.items.filter(i => i.sku !== sku)
        })),
      
      updateQty: (sku: string, qty: number) =>
        set(state => ({
          items: state.items.map(i =>
            i.sku === sku ? { ...i, qty: Math.max(0, qty) } : i
          ).filter(i => i.qty > 0)
        })),
      
      clearCart: () =>
        set({
          items: [],
          requiredDate: null,
          deliveryAddress: null,
          poRef: null,
          notes: null
        }),
      
      setRequiredDate: (date: Date) =>
        set({ requiredDate: date }),
      
      setDeliveryAddress: (address: string) =>
        set({ deliveryAddress: address }),
      
      setPoRef: (ref: string) =>
        set({ poRef: ref }),
      
      setNotes: (notes: string) =>
        set({ notes }),
      
      getTotal: () => {
        const { items } = get();
        return items.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
      },
      
      getLineCount: () => get().items.length,
      
      isCartReady: () => {
        const { items, requiredDate, deliveryAddress } = get();
        return items.length > 0 && requiredDate !== null && deliveryAddress !== null;
      }
    }),
    {
      name: 'hayward-cart',
      version: 1
    }
  )
);
