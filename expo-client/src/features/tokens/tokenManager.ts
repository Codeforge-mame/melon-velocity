import AsyncStorage from "@react-native-async-storage/async-storage";

const TOKEN_KEY = "daily_tokens";

export const DEFAULT_DAILY_TOKENS = 5;

function dailyKey(date = new Date()): string {
  return `${TOKEN_KEY}_${date.toISOString().slice(0, 10)}`;
}

export async function getRemainingTokens(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(dailyKey());
    if (raw === null) return DEFAULT_DAILY_TOKENS;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? DEFAULT_DAILY_TOKENS : Math.max(0, parsed);
  } catch {
    return DEFAULT_DAILY_TOKENS;
  }
}

/**
 * Consume one download token for today. Returns true when a token was
 * available and consumed, false when the daily quota is exhausted.
 */
export async function consumeToken(): Promise<boolean> {
  const remaining = await getRemainingTokens();
  if (remaining <= 0) return false;
  try {
    await AsyncStorage.setItem(dailyKey(), String(remaining - 1));
  } catch {
    return false;
  }
  return true;
}

/**
 * Grant tokens (e.g. from a future AdMob rewarded-ad callback).
 */
export async function addTokens(count: number): Promise<number> {
  const remaining = await getRemainingTokens();
  const next = remaining + Math.max(0, count);
  try {
    await AsyncStorage.setItem(dailyKey(), String(next));
  } catch {
    // ignore
  }
  return next;
}
