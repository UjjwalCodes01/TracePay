import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
  path: string;
}

type Behaviour = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A local HTTP server standing in for a customer's webhook endpoint. */
export class WebhookReceiver {
  readonly received: Received[] = [];
  private behaviour: Behaviour = (_req, res) => res.writeHead(200).end('ok');
  private server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      this.received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), path: req.url ?? '/' });
      this.behaviour(req, res);
    });
  });

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  url(path = '/hooks'): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  respond(behaviour: Behaviour): void {
    this.behaviour = behaviour;
  }

  status(code: number, body = ''): void {
    this.respond((_req, res) => res.writeHead(code).end(body));
  }

  reset(): void {
    this.received.length = 0;
    this.status(200, 'ok');
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
