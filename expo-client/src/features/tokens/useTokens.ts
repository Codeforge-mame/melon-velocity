import { useCallback, useState } from "react";

import { DEFAULT_DAILY_TOKENS, getRemainingTokens } from "./tokenManager";

export function useTokens() {
  const [remaining, setRemaining] = useState<number>(DEFAULT_DAILY_TOKENS);

  const refresh = useCallback(async () => {
    setRemaining(await getRemainingTokens());
  }, []);

  return { remaining, refresh, setRemaining };
}
