import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { SignInButton } from '@clerk/nextjs';
import Image from 'next/image';
import { Boxes, Receipt, Tag } from 'lucide-react';

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect('/dashboard');

  return (
    <main className="min-h-screen bg-wave-gradient flex flex-col items-center justify-center px-6 py-20">
      <div className="flex flex-col items-center gap-6 text-center max-w-2xl">
        <Image src="/hayward-logo.png" alt="Hayward" width={220} height={50} className="h-10 w-auto" priority />

        <h1 className="font-display text-5xl md:text-6xl text-deep font-bold tracking-tight">
          Everything you need,
          <br />
          in one place.
        </h1>

        <p className="max-w-md text-lg text-ink/60">
          Live stock, order status, and your pricing - built for Hayward's
          distributor network.
        </p>

        <SignInButton mode="modal">
          <button className="mt-2 rounded-full bg-wave px-8 py-3.5 text-white font-semibold shadow-glow hover:bg-deep transition-colors">
            Sign in to your portal
          </button>
        </SignInButton>

        <div className="mt-12 grid grid-cols-3 gap-8 text-ink/50">
          <div className="flex flex-col items-center gap-2">
            <Boxes className="h-6 w-6 text-wave" />
            <span className="text-sm font-medium">Live stock</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Receipt className="h-6 w-6 text-wave" />
            <span className="text-sm font-medium">Order status</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <Tag className="h-6 w-6 text-wave" />
            <span className="text-sm font-medium">Your pricing</span>
          </div>
        </div>
      </div>
    </main>
  );
}
