import { HttpClientOptions } from './types';

/**
 * Headers realistas para evitar bloqueio pelo YouTube
 */
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Semáforo para controle de concorrência
 */
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

/**
 * Cliente HTTP otimizado para scraping do YouTube
 */
export class HttpClient {
  private options: Required<HttpClientOptions>;
  private semaphore: Semaphore;
  private lastRequestTime = 0;

  constructor(options: HttpClientOptions = {}) {
    this.options = {
      minDelay: options.minDelay ?? 100,
      maxDelay: options.maxDelay ?? 500,
      maxConcurrent: options.maxConcurrent ?? 3,
      maxRetries: options.maxRetries ?? 3,
      timeout: options.timeout ?? 10000,
    };
    this.semaphore = new Semaphore(this.options.maxConcurrent);
  }

  /**
   * Aguarda um tempo aleatório entre minDelay e maxDelay
   */
  private async randomDelay(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const delay = Math.floor(
      Math.random() * (this.options.maxDelay - this.options.minDelay) + this.options.minDelay
    );
    
    if (elapsed < delay) {
      await this.sleep(delay - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Calcula delay para backoff exponencial
   */
  private getBackoffDelay(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt), 30000);
  }

  /**
   * Faz um GET request com retry automático
   */
  async get(url: string, customHeaders?: Record<string, string>): Promise<string> {
    await this.semaphore.acquire();
    
    try {
      await this.randomDelay();
      
      let lastError: (Error & { status?: number }) | null = null;
      
      for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);
          
          const response = await fetch(url, {
            method: 'GET',
            headers: { ...DEFAULT_HEADERS, ...customHeaders },
            signal: controller.signal,
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            if (response.status === 429) {
              // Rate limited - aguarda mais tempo
              const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
              console.warn(`Rate limited. Aguardando ${retryAfter}s...`);
              await this.sleep(retryAfter * 1000);
              continue;
            }
            
            const httpError = new Error(`HTTP ${response.status}: ${response.statusText}`) as Error & { status: number };
            httpError.status = response.status;
            throw httpError;
          }
          
          return await response.text();
        } catch (error) {
          lastError = error as Error & { status?: number };
          
          // 404 e 403 não adianta retry - recurso não existe ou sem permissão
          if (lastError.status === 404 || lastError.status === 403) {
            throw lastError;
          }
          
          if (attempt < this.options.maxRetries - 1) {
            const backoffDelay = this.getBackoffDelay(attempt);
            const errorMsg = lastError.name === 'AbortError' ? 'Timeout' : lastError.message;
            console.warn(`⚠️ Tentativa ${attempt + 1} falhou: ${errorMsg}`);
            console.warn(`   URL: ${url}`);
            await this.sleep(backoffDelay);
          }
        }
      }
      
      throw lastError || new Error('Request failed');
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * Faz múltiplos GETs em paralelo (respeitando concorrência)
   */
  async getMany(urls: string[]): Promise<Map<string, string | Error>> {
    const results = new Map<string, string | Error>();
    
    await Promise.all(
      urls.map(async url => {
        try {
          const html = await this.get(url);
          results.set(url, html);
        } catch (error) {
          results.set(url, error as Error);
        }
      })
    );
    
    return results;
  }
}

/**
 * Instância padrão do cliente HTTP
 */
export const httpClient = new HttpClient();

