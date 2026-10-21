import { inside, readText } from './storage.js';
import { yamlObject } from './sources.js';
import type { Device } from './model.js';

export interface RuntimeState {
  proxies: Record<
    string,
    { type: string; all?: string[]; now?: string; fixed?: string; testUrl?: string }
  >;
  providers: Record<
    string,
    {
      proxies?: {
        name: string;
        history?: { time: string; delay: number }[];
        extra?: Record<string, { history?: { time: string; delay: number }[] }>;
      }[];
    }
  >;
  rules: { type: string; payload: string; proxy: string }[];
}

export interface Runtime {
  read(): Promise<RuntimeState>;
  select(name: string, value: string | null): Promise<void>;
  refresh(provider: string): Promise<void>;
  probe?(
    provider: string,
    node: string,
    url: string,
    timeout: number,
  ): Promise<{ delay: number; outcome: 'ok' | 'networkFailure' | 'httpResponseOnRetry' }>;
}

class ControllerFailure extends Error {
  constructor(readonly status?: number) {
    super('本机控制器请求失败或暂未就绪');
  }
}

export class Controller implements Runtime {
  constructor(
    private readonly device: Device,
    private readonly signal?: AbortSignal,
  ) {}

  private async request(
    endpoint: string,
    method = 'GET',
    body?: unknown,
    timeout = 5000,
  ): Promise<any> {
    let config: Record<string, any> = {};
    for (const name of ['clash-verge.yaml', 'config.yaml']) {
      try {
        const candidate = yamlObject(await readText(await inside(this.device.configDir, name)));
        if (candidate['external-controller']) {
          config = candidate;
          break;
        }
      } catch {
        /* 不回显可能包含凭据的解析上下文。 */
      }
    }
    const address = String(config['external-controller'] ?? '');
    if (!/^127\.0\.0\.1:\d+$/.test(address))
      throw new Error('运行核验要求已配置的 IPv4 回环控制器');
    try {
      const response = await fetch(`http://${address}${endpoint}`, {
        method,
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
        headers: {
          Authorization: `Bearer ${config.secret ?? ''}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new ControllerFailure(response.status);
      return response.status === 204 ? null : response.json();
    } catch (error) {
      if (error instanceof ControllerFailure) throw error;
      throw new ControllerFailure();
    }
  }

  async read(): Promise<RuntimeState> {
    const [proxies, providers, rules] = await Promise.all([
      this.request('/proxies'),
      this.request('/providers/proxies'),
      this.request('/rules'),
    ]);
    return { proxies: proxies.proxies, providers: providers.providers, rules: rules.rules };
  }

  async select(name: string, value: string | null): Promise<void> {
    await this.request(
      `/proxies/${encodeURIComponent(name)}`,
      value === null ? 'DELETE' : 'PUT',
      value === null ? undefined : { name: value },
    );
  }

  async refresh(provider: string): Promise<void> {
    await this.request(`/providers/proxies/${encodeURIComponent(provider)}`, 'PUT');
  }

  async probe(provider: string, node: string, url: string, timeout: number) {
    for (const expected of ['200-399', '200-599']) {
      const query = new URLSearchParams({ url, timeout: String(timeout), expected });
      try {
        const result = await this.request(
          `/providers/proxies/${encodeURIComponent(provider)}/${encodeURIComponent(node)}/healthcheck?${query}`,
          'GET',
          undefined,
          timeout + 5000,
        );
        if (!(result.delay > 0)) throw new ControllerFailure(503);
        return {
          delay: result.delay as number,
          outcome: expected === '200-399' ? ('ok' as const) : ('httpResponseOnRetry' as const),
        };
      } catch (error) {
        if (
          !(error instanceof ControllerFailure) ||
          !error.status ||
          ![500, 503, 504].includes(error.status)
        )
          throw new Error('网站探测控制器不可用，未计入节点评分');
      }
    }
    return { delay: 0, outcome: 'networkFailure' as const };
  }
}
