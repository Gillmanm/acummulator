'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Localize } from '@deriv-com/translations';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';
import { Header } from '@/components/custom/header';
import { ThemeToggle } from '@/components/custom/theme-toggle';
import { Footer } from '@/components/custom/footer';
import { AccumulatorScanner } from '@/components/accumulator-scanner';

export default function AccumulatorScannerPage() {
  const logoSrc = useLogoSrc();
  const router = useRouter();
  const { ws, isConnected, auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;

  useEffect(() => {
    if (authState === 'unauthenticated' || authState === 'error') router.replace('/');
  }, [authState, router]);

  if (authState !== 'authenticated') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </main>
    );
  }

  return (
    <main className="flex flex-col bg-background max-lg:min-h-dvh max-lg:overflow-y-auto lg:min-h-dvh">
      <Header
        authState={authState}
        accounts={accounts}
        activeAccount={activeAccount}
        onLogin={login}
        onSignUp={signUp}
        onLogout={logout}
        onSwitchAccount={switchAccount}
        logoSrc={logoSrc}
        actions={<ThemeToggle />}
      />
      <div className="h-[76px] shrink-0" />
      <div className="mx-auto w-full max-w-7xl flex-1 px-3 py-4 pb-14 sm:px-4 sm:py-6">
        <Link href="/" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <span className="text-base leading-none">←</span>
          <span><Localize i18n_default_text="Back" /></span>
        </Link>
        <AccumulatorScanner ws={ws} isConnected={isConnected && !!auth.wsUrl} />
      </div>
      <div className="fixed bottom-0 left-0 right-0 py-2 text-center bg-background/80 backdrop-blur-sm">
        <Footer />
      </div>
    </main>
  );
}
