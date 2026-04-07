/**
 * Secrets manager for SEO Generator V3
 * Reads from process.env — Doppler CLI injects secrets via `doppler run --`
 */

class SecretsManager {
  private cache: Map<string, string> = new Map();

  get(key: string): string | undefined {
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    const value = process.env[key];
    if (value) {
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key) || !!process.env[key];
  }
}

export const secrets = new SecretsManager();
