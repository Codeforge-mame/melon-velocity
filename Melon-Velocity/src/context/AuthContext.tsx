import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { BACKEND_BASE_URL } from '../constants/config';

export type SocialPlatform = 'youtube' | 'tiktok' | 'telegram';

export interface SocialAccount {
  platform: SocialPlatform;
  configured: boolean;
  updated_at: string;
}

interface AuthContextValue {
  accessToken: string | null;
  email: string | null;
  isReady: boolean;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>;
  ensureAccessToken: () => Promise<string | null>;
  login: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  saveSocialCookies: (platform: SocialPlatform, cookies: string) => Promise<void>;
  deleteSocialAccount: (platform: SocialPlatform) => Promise<void>;
  getSocialAccounts: () => Promise<SocialAccount[]>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { detail?: string };
    return body.detail || 'The account request could not be completed.';
  } catch {
    return 'The account request could not be completed.';
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  const refreshSession = useCallback(async (): Promise<{
    accessToken: string;
    email: string;
  } | null> => {
    const response = await fetch(`${BACKEND_BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) return null;
    const result = await response.json() as {
      access_token: string;
      user: { email: string };
    };
    return { accessToken: result.access_token, email: result.user.email };
  }, []);

  const updateSession = useCallback((session: { accessToken: string; email: string } | null) => {
    if (!session) {
      setAccessToken(null);
      setEmail(null);
    } else {
      setAccessToken(session.accessToken);
      setEmail(session.email);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refreshSession()
      .then((session) => {
        if (active) updateSession(session);
      })
      .catch((error: unknown) => {
        console.error('[MeloStream session restore failed]', error);
      })
      .finally(() => {
        if (active) setIsReady(true);
      });
    return () => {
      active = false;
    };
  }, [refreshSession, updateSession]);

  const apiFetch = useCallback(async (path: string, init: RequestInit = {}) => {
    const send = (token: string | null) => {
      const headers = new Headers(init.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(`${BACKEND_BASE_URL}${path}`, {
        ...init,
        headers,
        credentials: 'include',
      });
    };

    let response = await send(accessToken);
    if (
      response.status !== 401 ||
      path.startsWith('/auth/token') ||
      path.startsWith('/auth/signup') ||
      path.startsWith('/auth/refresh')
    ) {
      return response;
    }

    const session = await refreshSession();
    updateSession(session);
    if (!session) return response;
    response = await send(session.accessToken);
    return response;
  }, [accessToken, refreshSession, updateSession]);

  const ensureAccessToken = useCallback(async () => {
    const session = await refreshSession();
    updateSession(session);
    return session?.accessToken ?? null;
  }, [refreshSession, updateSession]);

  const login = useCallback(async (loginEmail: string, password: string) => {
    const response = await fetch(`${BACKEND_BASE_URL}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: new URLSearchParams({ username: loginEmail, password }).toString(),
    });
    if (!response.ok) throw new Error(await readError(response));
    const result = await response.json() as {
      access_token: string;
      user: { email: string };
    };
    setAccessToken(result.access_token);
    setEmail(result.user.email);
  }, []);

  const signUp = useCallback(async (signupEmail: string, password: string) => {
    const response = await fetch(`${BACKEND_BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: signupEmail, password }),
    });
    if (!response.ok) throw new Error(await readError(response));
    await login(signupEmail, password);
  }, [login]);

  const logout = useCallback(async () => {
    const response = await apiFetch('/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error(await readError(response));
    setAccessToken(null);
    setEmail(null);
  }, [apiFetch]);

  const saveSocialCookies = useCallback(async (platform: SocialPlatform, cookies: string) => {
    const response = await apiFetch(`/auth/social-accounts/${platform}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
    });
    if (!response.ok) throw new Error(await readError(response));
  }, [apiFetch]);

  const deleteSocialAccount = useCallback(async (platform: SocialPlatform) => {
    const response = await apiFetch(`/auth/social-accounts/${platform}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(await readError(response));
  }, [apiFetch]);

  const getSocialAccounts = useCallback(async (): Promise<SocialAccount[]> => {
    const response = await apiFetch('/auth/social-accounts');
    if (!response.ok) throw new Error(await readError(response));
    return response.json() as Promise<SocialAccount[]>;
  }, [apiFetch]);

  const value = useMemo(
    () => ({
      accessToken,
      email,
      isReady,
      apiFetch,
      ensureAccessToken,
      login,
      signUp,
      logout,
      saveSocialCookies,
      deleteSocialAccount,
      getSocialAccounts,
    }),
    [
      accessToken,
      email,
      isReady,
      apiFetch,
      ensureAccessToken,
      login,
      signUp,
      logout,
      saveSocialCookies,
      deleteSocialAccount,
      getSocialAccounts,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
