declare module "node:http" {
  export interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    on(event: "data", listener: (chunk: string | Uint8Array) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: unknown) => void): this;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  }

  export interface Server {
    listen(port: number, host: string, callback?: () => void): this;
    close(callback?: (error?: Error) => void): this;
  }

  export function createServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare class TextDecoder {
  decode(input?: Uint8Array): string;
}

declare class URL {
  readonly pathname: string;
  readonly searchParams: { get(name: string): string | null };
  constructor(input: string, base?: string);
}
