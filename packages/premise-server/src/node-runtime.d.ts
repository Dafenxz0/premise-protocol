declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:http" {
  export interface IncomingHttpHeaders {
    readonly [key: string]: string | string[] | undefined;
  }

  export interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
    readonly headers: IncomingHttpHeaders;
    on(event: "data", listener: (chunk: Uint8Array) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    resume(): this;
  }

  export interface ServerResponse {
    statusCode: number;
    readonly writableEnded?: boolean;
    setHeader(name: string, value: string | number): this;
    end(chunk?: string | Uint8Array): this;
  }

  export interface Server {
    on(event: "error", listener: (error: Error) => void): this;
    listen(port: number, hostname?: string, callback?: () => void): this;
    close(callback?: (error?: Error) => void): this;
    address(): { readonly port: number } | string | null;
  }

  export function createServer(listener: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare module "node:url" {
  export class URL {
    constructor(input: string, base?: string);
    readonly pathname: string;
  }
}

declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
